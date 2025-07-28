import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import debounce from 'lodash.debounce';
import * as minimatch from 'minimatch';
import ignore from 'ignore';
import * as fs from 'fs';

interface SearchResult extends vscode.QuickPickItem {
  filePath: string;
  line: number;
  text: string;
}

interface FileQuickPickItem extends vscode.QuickPickItem {
  filePath: string;
}

let lastSearchResults: SearchResult[] = [];
let workspaceFolder: string | undefined;
let lastSearchFolder: string | undefined;
const PREVIEW_LINE_CONTEXT = 2;
const MAX_SEARCH_RESULTS = 300;
const SEARCH_DEBOUNCE_MS = 150; // Reduced for faster response
const STREAM_UPDATE_INTERVAL = 100; // Update UI every 100ms during streaming

// Configuration for search scope
interface SearchConfig {
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;
  recentFolders: string[];
  maxItemsInPicker: number;
  previewLines: number;
}

// Cache management functions
function getCacheKey(query: string, folder: string): string {
  return `${query}:${folder}`;
}

function getCachedResults(query: string, folder: string): SearchResult[] | null {
  const key = getCacheKey(query, folder);
  const entry = searchCache.get(key);
  
  if (!entry) return null;
  
  // Check if cache is still valid
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  
  return entry.results;
}

function setCachedResults(query: string, folder: string, results: SearchResult[]): void {
  // Clean old entries if cache is full
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldest = Array.from(searchCache.entries())
      .sort(([,a], [,b]) => a.timestamp - b.timestamp)[0];
    if (oldest) {
      searchCache.delete(oldest[0]);
    }
  }
  
  const key = getCacheKey(query, folder);
  searchCache.set(key, {
    query,
    folder,
    results,
    timestamp: Date.now()
  });
}

function getSearchConfig(): SearchConfig {
  const config = vscode.workspace.getConfiguration('telescopeLikeSearch');
  
  return {
    includePatterns: ['**/*'], // Include all files by default
    excludePatterns: [
      ...config.get('excludePatterns', []),
      '**/node_modules/**',
      '**/.git/**'
    ],
    maxFileSize: config.get('maxFileSize', 1048576),
    recentFolders: config.get('recentFolders', []),
    maxItemsInPicker: config.get('maxItemsInPicker', 30),
    previewLines: config.get('previewLines', 1)
  };
}

function updateRecentFolders(folder: string) {
  const config = vscode.workspace.getConfiguration('telescopeLikeSearch');
  const recentFolders = config.get('recentFolders', []) as string[];
  const updatedFolders = [folder, ...recentFolders.filter(f => f !== folder)].slice(0, 5);
  config.update('recentFolders', updatedFolders, true);
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

// In-memory indexes
let folderIndex: string[] = [];
let fileIndex: string[] = [];

let gitignoreMatcher: ReturnType<typeof ignore> | null = null;

async function loadGitignorePatterns(root: string) {
  gitignoreMatcher = ignore();
  try {
    const gitignorePath = path.join(root, '.gitignore');
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
    const lines = content.toString().split('\n');
    gitignoreMatcher.add(lines);
  } catch {
    // No .gitignore, ignore
  }
}

function isIgnoredByGitignore(relPath: string): boolean {
  return gitignoreMatcher ? gitignoreMatcher.ignores(relPath) : false;
}

let outputChannel: vscode.OutputChannel;
let debugChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

// Use the in-memory index for subfolder listing
async function getSubfolders(folderPath: string): Promise<string[]> {
  // Only return subfolders that are direct or nested children of folderPath
  return folderIndex.filter(f => f.startsWith(folderPath) && f !== folderPath);
}

async function getAllSubfolders(rootPath: string): Promise<string[]> {
  const folders: string[] = [];
  
  // Initialize gitignore matcher
  const ig = ignore();
  try {
    const gitignorePath = path.join(rootPath, '.gitignore');
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
    const lines = content.toString().split('\n');
    ig.add(lines);
  } catch {
    // No .gitignore, ignore
  }

  // Add common patterns to ignore
  ig.add([
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.vscode/**',
    '**/.idea/**'
  ]);
  
  async function scanDirectory(dir: string) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          const fullPath = path.join(dir, name);
          const relativePath = path.relative(rootPath, fullPath);
          
          // Skip if the folder matches any ignore patterns
          if (ig.ignores(relativePath)) {
            continue;
          }
          
          folders.push(fullPath);
          await scanDirectory(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
    }
  }

  await scanDirectory(rootPath);
  return folders;
}

interface FolderUsage {
  freq: number;
  last: number;
}

function getFolderUsageMap(context: vscode.ExtensionContext): Record<string, FolderUsage> {
  return context.workspaceState.get<Record<string, FolderUsage>>('liveSearchFolderUsage', {});
}

async function updateFolderUsage(context: vscode.ExtensionContext, folder: string) {
  const usage = getFolderUsageMap(context);
  const now = Date.now();
  if (!usage[folder]) usage[folder] = { freq: 0, last: 0 };
  usage[folder].freq += 1;
  usage[folder].last = now;
  await context.workspaceState.update('liveSearchFolderUsage', usage);
}

async function selectSearchFolder(context: vscode.ExtensionContext): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folders open.');
    return undefined;
  }

  workspaceFolder = workspaceFolders[0].uri.fsPath;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Invalid workspace folder path.');
    return undefined;
  }

  // Add the root folder as the first option
  const rootItem = {
    label: 'Current Folder',
    description: workspaceFolder,
    detail: `📁 ${workspaceFolder}`
  };

  const quickPick = vscode.window.createQuickPick();
  quickPick.items = [rootItem];
  quickPick.placeholder = 'Type to search folders...';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  // Initialize gitignore matcher
  const ig = ignore();
  try {
    const gitignorePath = path.join(workspaceFolder, '.gitignore');
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
    const lines = content.toString().split('\n');
    ig.add(lines);
  } catch {
    // No .gitignore, ignore
  }

  // Add common patterns to ignore
  ig.add([
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.vscode/**',
    '**/.idea/**'
  ]);

  let isSearching = false;
  const MAX_DEPTH = 3; // Limit folder depth to prevent excessive scanning
  const MAX_FOLDERS = 1000; // Limit total folders to prevent overwhelming the picker

  async function scanFolders(dir: string, depth: number, searchTerm: string): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    
    const folders: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      
      // Process entries in parallel chunks
      const CHUNK_SIZE = 10;
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        const chunkResults = await Promise.all(
          chunk.map(async ([name, type]) => {
            if (type !== vscode.FileType.Directory) return null;
            
            const fullPath = path.join(dir, name);
            const relativePath = path.relative(workspaceFolder!, fullPath);
            
            // Skip if the folder matches any ignore patterns
            if (ig.ignores(relativePath)) {
              return null;
            }

            // Only add if it matches the search term
            if (!searchTerm || relativePath.toLowerCase().includes(searchTerm.toLowerCase())) {
              return fullPath;
            }

            // Only recurse if we haven't hit the folder limit
            if (folders.length < MAX_FOLDERS) {
              const subFolders = await scanFolders(fullPath, depth + 1, searchTerm);
              return subFolders;
            }
            return null;
          })
        );

        // Flatten and filter results
        const validResults = chunkResults
          .filter((result): result is string | string[] => result !== null)
          .flat();
        
        folders.push(...validResults);
        
        // Break if we've hit the limit
        if (folders.length >= MAX_FOLDERS) {
          break;
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
    }
    return folders.slice(0, MAX_FOLDERS);
  }

  quickPick.onDidChangeValue(async (value) => {
    if (isSearching) return;
    isSearching = true;
    quickPick.busy = true;

    try {
      if (!value) {
        quickPick.items = [rootItem];
        return;
      }

      const folders = await scanFolders(workspaceFolder!, 0, value);
      
      const items = folders.map(folder => ({
        label: path.relative(workspaceFolder!, folder),
        description: folder,
        detail: `📁 ${folder}`
      }));

      quickPick.items = [rootItem, ...items];
    } finally {
      quickPick.busy = false;
      isSearching = false;
    }
  });

  return new Promise<string | undefined>((resolve) => {
    let resolved = false;
    quickPick.onDidAccept(() => {
      if (resolved) return;
      resolved = true;
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      if (selected?.description) {
        updateFolderUsage(context, selected.description);
        resolve(selected.description);
      } else {
        resolve(undefined);
      }
    });
    quickPick.onDidHide(() => {
      if (resolved) return;
      resolved = true;
      resolve(undefined);
    });
    quickPick.show();
  });
}

async function testFolderSelection() {
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder is open');
    return;
  }

  // At this point we know workspaceFolder is defined
  const rootFolder = workspaceFolder;
  const folders = await getSubfolders(rootFolder);
  console.log('Available folders:', folders);
  
  const items = folders.map(folder => {
    const relativePath = path.relative(rootFolder, folder);
    return {
      label: relativePath,
      description: folder,
      detail: `📁 ${folder}`
    };
  });
  
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a folder to search in',
    matchOnDescription: true,
    matchOnDetail: true
  });
  
  if (selected) {
    console.log('Selected folder:', selected.description);
    vscode.window.showInformationMessage(`Selected folder: ${selected.description}`);
  }
}

// Frecency helpers for file picker
interface FileUsage {
  freq: number;
  last: number;
}

function getFileUsageMap(context: vscode.ExtensionContext): Record<string, FileUsage> {
  return context.workspaceState.get<Record<string, FileUsage>>('liveSearchFileUsage', {});
}

async function updateFileUsage(context: vscode.ExtensionContext, file: string) {
  const usage = getFileUsageMap(context);
  const now = Date.now();
  if (!usage[file]) usage[file] = { freq: 0, last: 0 };
  usage[file].freq += 1;
  usage[file].last = now;
  await context.workspaceState.update('liveSearchFileUsage', usage);
}

function getTopFrecencyFiles(context: vscode.ExtensionContext, files: string[], limit?: number): string[] {
  const usage = getFileUsageMap(context);
  const now = Date.now();
  const recencyWeight = 1 / (1000 * 60 * 60 * 24); // 1 point per day
  const maxItems = limit || getSearchConfig().maxItemsInPicker;
  return files
    .map(f => {
      const u = usage[f];
      let score = 0;
      if (u) {
        score = u.freq + recencyWeight * (now - u.last);
      }
      return { file: f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(x => x.file);
}

function getTopFrecencyFolders(context: vscode.ExtensionContext, folders: string[], limit?: number): string[] {
  const usage = getFolderUsageMap(context);
  const now = Date.now();
  const recencyWeight = 1 / (1000 * 60 * 60 * 24); // 1 point per day
  const maxItems = limit || getSearchConfig().maxItemsInPicker;
  return folders
    .map(f => {
      const u = usage[f];
      let score = 0;
      if (u) {
        score = u.freq + recencyWeight * (now - u.last);
      }
      return { folder: f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(x => x.folder);
}

// Performance optimizations for huge repositories
const FILE_BATCH_SIZE = 100;
const MAX_CONCURRENT_OPERATIONS = 10;
const DEBOUNCE_DELAY = 50; // Reduced for faster response
const MAX_INITIAL_FILES = 1000; // Show initial files quickly

// Enhanced file cache with LRU eviction
interface FileCacheEntry {
  files: string[];
  timestamp: number;
  size: number;
}

class FileCache {
  private cache = new Map<string, FileCacheEntry>();
  private readonly maxSize = 50;
  private readonly ttl = 60000; // 1 minute

  get(key: string): string[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.files;
  }

  set(key: string, files: string[]): void {
    // Remove oldest entries if cache is full
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    
    this.cache.set(key, {
      files,
      timestamp: Date.now(),
      size: files.length
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

const fileCache = new FileCache();

// Fast file discovery using ripgrep for better performance
async function getFilesWithRipgrep(rootPath: string, pattern?: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ['--files', '--hidden', '--no-messages'];
    
    // Add common exclusions for performance
    const exclusions = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.vscode',
      '.idea',
      'coverage',
      '.nyc_output',
      'target',
      'bin',
      'obj'
    ];
    
    exclusions.forEach(dir => {
      args.push('--glob', `!**/${dir}/**`);
    });
    
    if (pattern) {
      args.push('--glob', `*${pattern}*`);
    }
    
    args.push(rootPath);
    
    const rg = spawn('rg', args, { cwd: rootPath });
    const files: string[] = [];
    let buffer = '';
    
    if (rg.stdout) {
      rg.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            files.push(line.trim());
          }
        }
      });
    }
    
    rg.on('close', (code) => {
      if (buffer.trim()) {
        files.push(buffer.trim());
      }
      resolve(files);
    });
    
    rg.on('error', (error) => {
      // Fallback to filesystem scan if ripgrep fails
      console.warn('Ripgrep failed, falling back to filesystem scan:', error);
      getAllFilesFallback(rootPath).then(resolve).catch(reject);
    });
  });
}

// Fallback file discovery method
async function getAllFilesFallback(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const maxDepth = 8; // Limit depth for performance
  
  async function scanDirectory(dir: string, depth: number) {
    if (depth > maxDepth) return;
    
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      const promises: Promise<void>[] = [];
      
      for (const [name, type] of entries) {
        // Skip common non-source directories
        if (type === vscode.FileType.Directory) {
          if (['node_modules', '.git', 'dist', 'build', '.vscode', '.idea'].includes(name)) {
            continue;
          }
          
          promises.push(scanDirectory(path.join(dir, name), depth + 1));
        } else if (type === vscode.FileType.File) {
          files.push(path.join(dir, name));
        }
        
        // Process in batches to avoid overwhelming the system
        if (promises.length >= MAX_CONCURRENT_OPERATIONS) {
          await Promise.all(promises);
          promises.length = 0;
        }
      }
      
      if (promises.length > 0) {
        await Promise.all(promises);
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
    }
  }
  
  await scanDirectory(rootPath, 0);
  return files;
}

// Persistent file index similar to VSCode's approach
class WorkspaceFileIndex {
  private files: Set<string> = new Set();
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  
  constructor(private workspaceRoot: string, private outputChannel: vscode.OutputChannel) {
    this.setupFileWatcher();
  }

  private setupFileWatcher() {
    // Create a comprehensive file watcher
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    
    this.watcher.onDidCreate((uri) => {
      if (uri.scheme === 'file' && this.isRelevantFile(uri.fsPath)) {
        this.files.add(uri.fsPath);
        this.outputChannel.appendLine(`[File Index] Added: ${uri.fsPath}`);
      }
    });

    this.watcher.onDidDelete((uri) => {
      if (uri.scheme === 'file') {
        this.files.delete(uri.fsPath);
        this.outputChannel.appendLine(`[File Index] Removed: ${uri.fsPath}`);
      }
    });
  }

  private isRelevantFile(filePath: string): boolean {
    const relativePath = path.relative(this.workspaceRoot, filePath);
    
    // Skip if outside workspace
    if (relativePath.startsWith('..')) return false;
    
    // Skip common directories that should be excluded
    const excludedDirs = [
      'node_modules', '.git', 'dist', 'build', '.vscode', '.idea',
      'coverage', '.nyc_output', 'target', 'bin', 'obj', '.next',
      'out', '.cache', 'tmp', 'temp', '__pycache__'
    ];
    
    for (const dir of excludedDirs) {
      if (relativePath.includes(`${dir}/`) || relativePath.includes(`${dir}\\`)) {
        return false;
      }
    }
    
    // Assume it's a file if it passes directory checks
    // The file watcher should only notify us about actual files anyway
    return true;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const startTime = Date.now();
    this.outputChannel.appendLine('[File Index] Starting background initialization...');
    
    try {
      // Use VSCode's built-in file search for the initial index
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**,**/.idea/**,**/coverage/**,**/.nyc_output/**,**/target/**,**/bin/**,**/obj/**,**/.next/**,**/out/**,**/.cache/**,**/tmp/**,**/temp/**,**/__pycache__/**}',
        50000 // Reasonable limit
      );
      
      for (const file of files) {
        if (file.scheme === 'file') {
          this.files.add(file.fsPath);
        }
      }
      
      this.isInitialized = true;
      const duration = Date.now() - startTime;
      this.outputChannel.appendLine(`[File Index] Initialized with ${this.files.size} files in ${duration}ms`);
    } catch (error) {
      this.outputChannel.appendLine(`[File Index] Initialization failed: ${error}`);
      // Fallback to empty index rather than failing completely
      this.isInitialized = true;
    }
  }

  async getFiles(): Promise<string[]> {
    await this.initialize();
    return Array.from(this.files);
  }

  getFilesSync(): string[] {
    if (!this.isInitialized) {
      return [];
    }
    return Array.from(this.files);
  }

  dispose() {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
  }
}

// Global file index instance
let workspaceFileIndex: WorkspaceFileIndex | null = null;

// Initialize file index when workspace is available
function initializeFileIndex() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  if (workspaceFileIndex) {
    workspaceFileIndex.dispose();
  }

  workspaceFolder = workspaceFolders[0].uri.fsPath;
  workspaceFileIndex = new WorkspaceFileIndex(workspaceFolder, outputChannel);
  
  // Start background initialization immediately
  workspaceFileIndex.initialize().catch(error => {
    outputChannel.appendLine(`[File Index] Background initialization failed: ${error}`);
  });
}

// Ultra-fast file picker using pre-built index with preview
async function showInstantFilePicker(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (!workspaceFileIndex) {
    vscode.window.showErrorMessage('Workspace file index not available.');
    return;
  }

  outputChannel.appendLine('[Live Search] Opening instant file picker with preview...');
  
  // Get files immediately from index (may be empty if not initialized yet)
  let allFiles = workspaceFileIndex.getFilesSync();
  const searchConfig = getSearchConfig();
  const previewLines = searchConfig.previewLines;
  
  const quickPick = vscode.window.createQuickPick<FileWithPreviewQuickPickItem>();
  
  // Setup immediate response
  quickPick.placeholder = allFiles.length > 0 ? 
    `Type to search files (showing ${previewLines} line${previewLines > 1 ? 's' : ''} preview)...` : 
    'Loading files in background...';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.busy = allFiles.length === 0;

  // Add button to change preview lines
  quickPick.buttons = [
    {
      iconPath: new vscode.ThemeIcon('eye'),
      tooltip: 'Change preview lines'
    }
  ];

  quickPick.onDidTriggerButton(async () => {
    const options = ['1', '3', '5', '10', '20'].map(num => ({
      label: num,
      description: `${num} line${num !== '1' ? 's' : ''}`
    }));
    
    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: 'Select number of preview lines'
    });
    
    if (selected) {
      const newPreviewLines = parseInt(selected.label);
      // Update configuration
      const config = vscode.workspace.getConfiguration('telescopeLikeSearch');
      await config.update('previewLines', newPreviewLines, true);
      
      // Refresh items with new preview
      quickPick.busy = true;
      const currentFiles = quickPick.value ? 
        allFiles.filter(f => {
          const relativePath = path.relative(workspaceFolder!, f);
          return relativePath.toLowerCase().includes(quickPick.value.toLowerCase());
        }).slice(0, MAX_INITIAL_FILES) : 
        getTopFrecencyFiles(context, allFiles, MAX_INITIAL_FILES);
      
      quickPick.items = await buildFileItemsWithPreview(currentFiles.slice(0, 100), newPreviewLines);
      quickPick.placeholder = `Type to search files (showing ${newPreviewLines} line${newPreviewLines > 1 ? 's' : ''} preview)...`;
      quickPick.busy = false;
    }
  });

  // Show frecency files immediately if we have any files
  if (allFiles.length > 0) {
    const topFiles = getTopFrecencyFiles(context, allFiles, MAX_INITIAL_FILES);
    const initialItems = await buildFileItemsWithPreview(topFiles.slice(0, 100), previewLines);
    quickPick.items = initialItems;
    outputChannel.appendLine(`[Live Search] Showing ${initialItems.length} files with preview instantly from index`);
  }

  let isDisposed = false;
  let currentFilter = '';

  // If index is not ready, load in background
  if (allFiles.length === 0) {
    workspaceFileIndex.getFiles().then(files => {
      if (isDisposed) return;
      
      allFiles = files;
      quickPick.busy = false;
      quickPick.placeholder = `Type to search files (showing ${previewLines} line${previewLines > 1 ? 's' : ''} preview)...`;
      
      if (!currentFilter) {
        const topFiles = getTopFrecencyFiles(context, allFiles, MAX_INITIAL_FILES);
        buildFileItemsWithPreview(topFiles.slice(0, 100), previewLines).then(items => {
          if (!isDisposed) {
            quickPick.items = items;
            outputChannel.appendLine(`[Live Search] Updated with ${items.length} files with preview from completed index`);
          }
        });
      }
    }).catch(error => {
      if (!isDisposed) {
        quickPick.busy = false;
        outputChannel.appendLine(`[Live Search] Error loading file index: ${error}`);
      }
    });
  }

  // Ultra-fast filtering with minimal debounce and preview
  const debouncedFilter = debounce(async (query: string) => {
    if (isDisposed) return;
    
    currentFilter = query;
    
    // Use current files (might be empty initially)
    const files = allFiles.length > 0 ? allFiles : workspaceFileIndex!.getFilesSync();
    
    let filteredFiles: string[];
    
    if (!query) {
      filteredFiles = getTopFrecencyFiles(context, files, MAX_INITIAL_FILES);
    } else {
      // Super fast filtering - just check if the relative path includes the query
      const lowerQuery = query.toLowerCase();
      filteredFiles = files
        .filter(file => {
          const relativePath = path.relative(workspaceFolder!, file);
          return relativePath.toLowerCase().includes(lowerQuery);
        })
        .slice(0, MAX_INITIAL_FILES);
    }
    
    const items = await buildFileItemsWithPreview(filteredFiles.slice(0, 100), previewLines);
    
    if (isDisposed || currentFilter !== query) return;
    
    quickPick.items = items;
    outputChannel.appendLine(`[Live Search] Filtered to ${filteredFiles.length} files with preview, showing ${items.length}`);
  }, 25); // Even faster debounce

  quickPick.onDidChangeValue(debouncedFilter);

  return new Promise<string | undefined>((resolve) => {
    let resolved = false;
    
    quickPick.onDidAccept(async () => {
      if (resolved || isDisposed) return;
      resolved = true;
      isDisposed = true;
      
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      
      if (selected?.filePath) {
        await updateFileUsage(context, selected.filePath);
        outputChannel.appendLine(`[Live Search] File selected: ${selected.filePath}`);
        
        // Open the selected file
        try {
          const document = await vscode.workspace.openTextDocument(selected.filePath);
          await vscode.window.showTextDocument(document);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
        
        resolve(selected.filePath);
      } else {
        resolve(undefined);
      }
    });
    
    quickPick.onDidHide(() => {
      if (resolved) return;
      resolved = true;
      isDisposed = true;
      outputChannel.appendLine('[Live Search] Instant file picker closed.');
      resolve(undefined);
    });
    
    quickPick.show();
  });
}

// Optimized file picker with lazy loading and virtualization
async function showOptimizedFilePicker(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Use the instant picker if available, fallback to the previous optimized version
  if (workspaceFileIndex) {
    return showInstantFilePicker(context);
  }
  
  // Fallback to previous implementation
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  
  workspaceFolder = workspaceFolders[0].uri.fsPath;
  const cacheKey = `files:${workspaceFolder}`;
  
  outputChannel.appendLine('[Live Search] Opening optimized file picker...');
  
  // Try to get cached files first
  let allFiles = fileCache.get(cacheKey);
  const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
  
  // Setup quick pick immediately
  quickPick.placeholder = 'Type to search files... (loading in background)';
  quickPick.matchOnDescription = true;
  quickPick.busy = true;
  
  // Show frecency files immediately if no cache
  if (!allFiles) {
    const frecencyFiles = getTopFrecencyFiles(context, [], MAX_INITIAL_FILES);
    if (frecencyFiles.length > 0) {
      const initialItems = await buildFileItemsBatch(frecencyFiles.slice(0, 50));
      quickPick.items = initialItems;
      quickPick.busy = false;
      quickPick.placeholder = 'Type to search files... (loading more files in background)';
    }
  } else {
    // Use cached files immediately
    const topFiles = getTopFrecencyFiles(context, allFiles, MAX_INITIAL_FILES);
    const initialItems = await buildFileItemsBatch(topFiles.slice(0, 100));
    quickPick.items = initialItems;
    quickPick.busy = false;
    quickPick.placeholder = 'Type to search files...';
  }
  
  // Load files in background
  const loadFilesPromise = allFiles ? 
    Promise.resolve(allFiles) : 
    getFilesWithRipgrep(workspaceFolder);
  
  let isDisposed = false;
  let currentFilter = '';
  
  // Optimized filtering with debouncing
  const debouncedFilter = debounce(async (query: string) => {
    if (isDisposed) return;
    
    currentFilter = query;
    quickPick.busy = true;
    
    try {
      const files = await loadFilesPromise;
      
      if (isDisposed || currentFilter !== query) return;
      
      let filteredFiles: string[];
      
      if (!query) {
        filteredFiles = getTopFrecencyFiles(context, files, MAX_INITIAL_FILES);
      } else {
        // Fast filtering using simple string matching
        const lowerQuery = query.toLowerCase();
        filteredFiles = files
          .filter(file => {
            const relativePath = path.relative(workspaceFolder!, file);
            return relativePath.toLowerCase().includes(lowerQuery);
          })
          .slice(0, MAX_INITIAL_FILES);
      }
      
      const items = await buildFileItemsBatch(filteredFiles.slice(0, 100));
      
      if (isDisposed || currentFilter !== query) return;
      
      quickPick.items = items;
      quickPick.busy = false;
      
      outputChannel.appendLine(`[Live Search] Filtered to ${filteredFiles.length} files, showing ${items.length}`);
    } catch (error) {
      if (!isDisposed) {
        quickPick.busy = false;
        outputChannel.appendLine(`[Live Search] Error filtering files: ${error}`);
      }
    }
  }, DEBOUNCE_DELAY);
  
  quickPick.onDidChangeValue(debouncedFilter);
  
  // Cache files when loaded
  loadFilesPromise.then(files => {
    if (!isDisposed) {
      fileCache.set(cacheKey, files);
      outputChannel.appendLine(`[Live Search] Cached ${files.length} files`);
      
      // Update initial items if no filter is active
      if (!currentFilter) {
        debouncedFilter('');
      }
    }
  }).catch(error => {
    if (!isDisposed) {
      outputChannel.appendLine(`[Live Search] Error loading files: ${error}`);
      quickPick.busy = false;
    }
  });
  
  return new Promise<string | undefined>((resolve) => {
    let resolved = false;
    
    quickPick.onDidAccept(async () => {
      if (resolved || isDisposed) return;
      resolved = true;
      isDisposed = true;
      
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      
      if (selected?.filePath) {
        await updateFileUsage(context, selected.filePath);
        outputChannel.appendLine(`[Live Search] File selected: ${selected.filePath}`);
        
        // Open the selected file
        try {
          const document = await vscode.workspace.openTextDocument(selected.filePath);
          await vscode.window.showTextDocument(document);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
        
        resolve(selected.filePath);
      } else {
        resolve(undefined);
      }
    });
    
    quickPick.onDidHide(() => {
      if (resolved) return;
      resolved = true;
      isDisposed = true;
      outputChannel.appendLine('[Live Search] Optimized file picker closed.');
      resolve(undefined);
    });
    
    quickPick.show();
  });
}

// Optimized batch file item building
async function buildFileItemsBatch(fileList: string[]): Promise<FileQuickPickItem[]> {
  const items: FileQuickPickItem[] = [];
  
  // Process files in batches for better performance
  for (let i = 0; i < fileList.length; i += FILE_BATCH_SIZE) {
    const batch = fileList.slice(i, i + FILE_BATCH_SIZE);
    
    const batchItems = batch.map(file => {
      const relativePath = path.relative(workspaceFolder!, file);
      const fileName = path.basename(file);
      const fileDir = path.dirname(relativePath);
      
      return {
        label: fileName,
        description: fileDir === '.' ? '' : fileDir,
        filePath: file
      };
    });
    
    items.push(...batchItems);
    
    // Yield control periodically to keep UI responsive
    if (i % (FILE_BATCH_SIZE * 5) === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  return items;
}

// Use the in-memory index for file picker
async function getAllFiles(rootPath: string): Promise<string[]> {
  // Use the optimized version
  return getFilesWithRipgrep(rootPath);
}

async function selectFileToSearch(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Use the optimized file picker
  return showOptimizedFilePicker(context);
}

async function getCurrentFileFolder(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor.');
    return undefined;
  }

  const filePath = editor.document.uri.fsPath;
  return path.dirname(filePath);
}

async function showCodeLensView(context: vscode.ExtensionContext) {
  const grouped: Record<string, SearchResult[]> = {};
  for (const res of lastSearchResults) {
    if (!grouped[res.filePath]) grouped[res.filePath] = [];
    grouped[res.filePath].push(res);
  }

  const lines: string[] = [];
  const lensMap: { line: number, result: SearchResult }[] = [];

  // Process files in parallel with a limit
  const processFile = async (file: string, results: SearchResult[]) => {
    const fileLines: string[] = [];
    fileLines.push(`📁 ${file}`);
    
    for (const res of results) {
      const lineNum = lines.length + fileLines.length;
      lensMap.push({ line: lineNum, result: res });
      fileLines.push(`   → Line ${res.line + 1}: ${res.text}`);

      try {
        const doc = await vscode.workspace.openTextDocument(res.filePath);
        const start = Math.max(0, res.line - 1);
        const end = Math.min(doc.lineCount, res.line + 2);
        const contextLines = doc.getText(new vscode.Range(start, 0, end, 0)).split('\n');
        for (const ctxLine of contextLines) {
          fileLines.push(`      ${ctxLine}`);
        }
        fileLines.push('');
      } catch {
        fileLines.push('      [Unable to preview context]', '');
      }
    }
    fileLines.push('');
    return fileLines;
  };

  // Process files in batches to avoid overwhelming the system
  const batchSize = 10; // Increased batch size for better performance
  const files = Object.entries(grouped);
  
  // Show loading indicator
  const loadingMessage = vscode.window.setStatusBarMessage('Loading search results...');
  
  try {
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(([file, results]) => processFile(file, results))
      );
      lines.push(...batchResults.flat());
      
      // Update progress
      const progress = Math.min(100, Math.round((i + batchSize) / files.length * 100));
      loadingMessage.dispose();
      vscode.window.setStatusBarMessage(`Loading search results... ${progress}%`);
    }
  } finally {
    loadingMessage.dispose();
  }

  const content = lines.join('\n');
  const uri = vscode.Uri.parse('telescope-results:/results');

  const provider = new (class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(): string {
      return content;
    }
  })();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('telescope-results', provider)
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'telescope-results' }, new GroupedCodeLensProvider(lensMap)),
    vscode.languages.registerHoverProvider({ scheme: 'telescope-results' }, {
      async provideHover(document, position) {
        const lineText = document.lineAt(position.line).text;
        const match = lineText.match(/Line (\d+): (.+)/);
        if (!match) return;
        const lineNumber = parseInt(match[1], 10) - 1;
        const matchedText = match[2].trim();
        const result = lastSearchResults.find(r => r.line === lineNumber && r.text === matchedText);
        if (!result) return;
        try {
          const doc = await vscode.workspace.openTextDocument(result.filePath);
          const contextLine = doc.lineAt(result.line).text;
          return new vscode.Hover(
            new vscode.MarkdownString(
              `**Preview from 📄 ${path.basename(result.filePath)}:${result.line + 1}**\n\n\`${contextLine.trim()}\``
            )
          );
        } catch {
          return new vscode.Hover('⚠️ Unable to load preview');
        }
      }
    }),
    vscode.languages.registerFoldingRangeProvider({ scheme: 'telescope-results' }, {
      provideFoldingRanges(document) {
        const ranges: vscode.FoldingRange[] = [];
        for (let i = 0; i < document.lineCount; i++) {
          const line = document.lineAt(i).text;
          if (line.startsWith('📁 ')) {
            const start = i;
            let end = i + 1;
            while (end < document.lineCount && !document.lineAt(end).text.startsWith('📁 ')) {
              end++;
            }
            if (end - start > 1) {
              ranges.push(new vscode.FoldingRange(start, end - 1));
            }
          }
        }
        return ranges;
      }
    })
  );

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

// Helper to launch search-in-file QuickPick for a given file
async function launchSearchInFileQuickPick(selectedFile: string) {
  outputChannel.appendLine(`[Live Search] Launching search-in-file picker for: ${selectedFile}`);
  const quickPick = vscode.window.createQuickPick<SearchResult>();

  quickPick.placeholder = `Search content in ${path.basename(selectedFile)}...`;
  quickPick.matchOnDescription = true;
  quickPick.busy = false;

  let currentProcess: ReturnType<typeof spawn> | null = null;
  let searchTimeout: NodeJS.Timeout | null = null;

  const runRipgrep = (query: string) => {
    if (currentProcess) {
      currentProcess.kill();
      currentProcess = null;
    }
    if (searchTimeout) clearTimeout(searchTimeout);
    
    if (!query || query.length < 2) {
      quickPick.items = [];
      quickPick.busy = false;
      outputChannel.appendLine('[Live Search] Search query too short or empty.');
      return;
    }

    // Check cache first
    const cacheKey = `file:${selectedFile}:${query}`;
    const cached = getCachedResults(query, cacheKey);
    if (cached) {
      quickPick.items = cached.length > 0 ? cached : [{ label: 'No matches found', description: '', filePath: '', line: -1, text: '' }];
      quickPick.busy = false;
      outputChannel.appendLine(`[Live Search] Using cached results: ${cached.length} items`);
      return;
    }

    quickPick.busy = true;
    outputChannel.appendLine(`[Live Search] Running ripgrep in file: ${selectedFile} | Query: "${query}"`);

    const ripgrepArgs = [
      '--vimgrep',
      '--smart-case',
      '--no-heading',
      '--color', 'never',
      '--text',
      '--line-number',
      '--max-count', MAX_SEARCH_RESULTS.toString(),
      query,
      selectedFile
    ];

    currentProcess = spawn('rg', ripgrepArgs, { 
      cwd: workspaceFolder
    });

    const results: SearchResult[] = [];
    let buffer = '';
    let updateTimer: NodeJS.Timeout | null = null;

    // Stream results for better UX
    const updateUI = () => {
      if (results.length > 0) {
        quickPick.items = results;
      }
    };

    if (currentProcess.stdout) {
      currentProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
          if (match) {
            const [, file, lineNum, text] = match;
            const trimmedText = text.trim();
            results.push({
              label: `Line ${lineNum}`,
              description: trimmedText.length > 100 ? trimmedText.substring(0, 97) + '...' : trimmedText,
              detail: `${path.basename(file)} (Line ${lineNum})`,
              filePath: file,
              line: parseInt(lineNum, 10) - 1,
              text: trimmedText
            });
          }
        }

        // Throttled UI updates for better performance
        if (!updateTimer) {
          updateTimer = setTimeout(() => {
            updateUI();
            updateTimer = null;
          }, STREAM_UPDATE_INTERVAL);
        }
      });
    }

    if (currentProcess.stderr) {
      currentProcess.stderr.on('data', (data) => {
        outputChannel.appendLine(`[Live Search] Error: ${data.toString()}`);
      });
    }

    currentProcess.on('close', (code) => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const match = buffer.match(/^(.+?):(\d+):\d+:(.*)$/);
        if (match) {
          const [, file, lineNum, text] = match;
          const trimmedText = text.trim();
          results.push({
            label: `Line ${lineNum}`,
            description: trimmedText.length > 100 ? trimmedText.substring(0, 97) + '...' : trimmedText,
            detail: `${path.basename(file)} (Line ${lineNum})`,
            filePath: file,
            line: parseInt(lineNum, 10) - 1,
            text: trimmedText
          });
        }
      }

      // Sort results by line number
      results.sort((a, b) => a.line - b.line);
      lastSearchResults = results;
      
      // Cache results
      setCachedResults(query, cacheKey, results);
      
      outputChannel.appendLine(`[Live Search] Search complete. Results: ${results.length}, Exit code: ${code}`);

      quickPick.items = results.length > 0
        ? results
        : [{ label: 'No matches found', description: '', filePath: '', line: -1, text: '' }];
      quickPick.busy = false;
    });

    currentProcess.on('error', (error) => {
      outputChannel.appendLine(`[Live Search] Process error: ${error.message}`);
      quickPick.busy = false;
      quickPick.items = [{ label: 'Search error occurred', description: error.message, filePath: '', line: -1, text: '' }];
    });

    // Set a timeout to show results even if search is taking too long
    searchTimeout = setTimeout(() => {
      if (quickPick.busy && results.length > 0) {
        updateUI();
        outputChannel.appendLine('[Live Search] Search taking too long, showing partial results.');
      }
    }, 3000); // 3 second timeout for partial results
  };

  const debouncedSearch = debounce(runRipgrep, SEARCH_DEBOUNCE_MS);
  quickPick.onDidChangeValue(debouncedSearch);

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (selected && selected.line >= 0) {
      outputChannel.appendLine(`[Live Search] Opening file at line: ${selected.line + 1}`);
      const doc = await vscode.workspace.openTextDocument(selected.filePath);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const pos = new vscode.Position(selected.line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } else {
      outputChannel.appendLine('[Live Search] Search-in-file picker accepted, but no result selected.');
    }
    quickPick.hide();
  });

  quickPick.onDidHide(() => {
    outputChannel.appendLine('[Live Search] Search-in-file picker closed.');
    quickPick.dispose();
    workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  });
  
  quickPick.show();
}

// Clear cache when files change to ensure freshness
function setupCacheInvalidation(context: vscode.ExtensionContext) {
  // Note: File index has its own watcher, we only need to clear search cache here
  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
  
  watcher.onDidChange(() => {
    // Clear search cache when files are modified
    if (searchCache.size > 0) {
      searchCache.clear();
      outputChannel.appendLine('[Live Search] Search cache cleared due to file changes');
    }
    fileCache.clear();
    outputChannel.appendLine('[Live Search] File cache cleared due to file changes');
  });
  
  watcher.onDidCreate(() => {
    // Clear search cache when files are created (file index handles its own updates)
    if (searchCache.size > 0) {
      searchCache.clear();
      outputChannel.appendLine('[Live Search] Search cache cleared due to new files');
    }
    fileCache.clear();
    outputChannel.appendLine('[Live Search] File cache cleared due to new files');
  });
  
  watcher.onDidDelete(() => {
    // Clear search cache when files are deleted (file index handles its own updates)
    if (searchCache.size > 0) {
      searchCache.clear();
      outputChannel.appendLine('[Live Search] Search cache cleared due to file deletions');
    }
    fileCache.clear();
    outputChannel.appendLine('[Live Search] File cache cleared due to file deletions');
  });
  
  context.subscriptions.push(watcher);
}

// Cache for search results
interface CacheEntry {
  query: string;
  folder: string;
  results: SearchResult[];
  timestamp: number;
}

const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30000; // 30 seconds
const MAX_CACHE_SIZE = 50;

interface FileWithPreviewQuickPickItem extends vscode.QuickPickItem {
  filePath: string;
  preview?: string;
}

// Helper function to read file preview
async function getFilePreview(filePath: string, previewLines: number): Promise<string> {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const lines = document.getText().split('\n');
    const previewText = lines.slice(0, previewLines).join('\n');
    return previewText || '(empty file)';
  } catch (error) {
    return '(unable to read file)';
  }
}

// Helper function to build file items with preview
async function buildFileItemsWithPreview(fileList: string[], previewLines: number): Promise<FileWithPreviewQuickPickItem[]> {
  const items = await Promise.all(fileList.map(async file => {
    const relativePath = path.relative(workspaceFolder!, file);
    const fileName = path.basename(file);
    const fileDir = path.dirname(relativePath);
    const preview = await getFilePreview(file, previewLines);
    
    return {
      label: fileName,
      description: fileDir === '.' ? '' : fileDir,
      detail: preview.length > 100 ? preview.substring(0, 100) + '...' : preview,
      filePath: file,
      preview: preview
    };
  }));
  
  return items;
}

// File picker with preview functionality
async function showFilePickerWithPreview(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Use the instant picker with preview - it's the fastest option
  if (workspaceFileIndex) {
    return showInstantFilePicker(context);
  }
  
  // Fallback to optimized picker without preview if file index not available
  return showOptimizedFilePicker(context);
}

// Add this interface after the existing interfaces
interface TelescopeWebviewItem {
  label: string;
  description: string;
  filePath: string;
  preview: string;
}

// Add this function before the activate function
function getTelescopeWebviewContent(items: TelescopeWebviewItem[], selectedIndex: number = 0): string {
  const selectedItem = items[selectedIndex] || { preview: 'No file selected' };
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telescope File Search</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .search-container {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-input-background);
        }
        
        .search-input {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
            outline: none;
        }
        
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        
        .main-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        
        .file-list {
            width: 50%;
            overflow-y: auto;
            border-right: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-sideBar-background);
        }
        
        .file-item {
            padding: 8px 12px;
            cursor: pointer;
            border-bottom: 1px solid transparent;
            display: flex;
            flex-direction: column;
        }
        
        .file-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .file-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .file-name {
            font-weight: 500;
            margin-bottom: 2px;
        }
        
        .file-path {
            font-size: 0.9em;
            opacity: 0.7;
        }
        
        .preview-panel {
            width: 50%;
            padding: 12px;
            overflow-y: auto;
            background-color: var(--vscode-editor-background);
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        
        .preview-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.4;
            color: var(--vscode-editor-foreground);
        }
        
        .line-number {
            display: inline-block;
            width: 40px;
            color: var(--vscode-editorLineNumber-foreground);
            text-align: right;
            margin-right: 12px;
            user-select: none;
        }
        
        .preview-line {
            display: block;
            margin: 0;
        }
        
        .status-bar {
            padding: 4px 8px;
            background-color: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            border-top: 1px solid var(--vscode-panel-border);
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <input type="text" class="search-input" placeholder="Search files..." id="searchInput" />
    </div>
    
    <div class="main-container">
        <div class="file-list" id="fileList">
            ${items.map((item, index) => `
                <div class="file-item ${index === selectedIndex ? 'selected' : ''}" data-index="${index}" data-path="${item.filePath}">
                    <div class="file-name">${item.label}</div>
                    <div class="file-path">${item.description}</div>
                </div>
            `).join('')}
        </div>
        
        <div class="preview-panel">
            <div class="preview-content" id="previewContent">
                ${selectedItem.preview.split('\n').map((line, i) => 
                    `<div class="preview-line"><span class="line-number">${i + 1}</span>${line || ' '}</div>`
                ).join('')}
            </div>
        </div>
    </div>
    
    <div class="status-bar" id="statusBar">
        ${items.length} files found
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentItems = ${JSON.stringify(items)};
        let selectedIndex = ${selectedIndex};
        let filteredItems = [...currentItems];
        
        const searchInput = document.getElementById('searchInput');
        const fileList = document.getElementById('fileList');
        const previewContent = document.getElementById('previewContent');
        const statusBar = document.getElementById('statusBar');
        
        function updatePreview(item) {
            if (!item) {
                previewContent.innerHTML = '<div class="preview-line">No file selected</div>';
                return;
            }
            
                         const lines = item.preview.split('\\\\n');
             previewContent.innerHTML = lines.map((line, i) => 
                 \`<div class="preview-line"><span class="line-number">\${i + 1}</span>\${line || ' '}</div>\`
             ).join('');
        }
        
        function updateFileList() {
            fileList.innerHTML = filteredItems.map((item, index) => \`
                <div class="file-item \${index === selectedIndex ? 'selected' : ''}" data-index="\${index}" data-path="\${item.filePath}">
                    <div class="file-name">\${item.label}</div>
                    <div class="file-path">\${item.description}</div>
                </div>
            \`).join('');
            
            statusBar.textContent = \`\${filteredItems.length} files found\`;
            
            // Update preview
            updatePreview(filteredItems[selectedIndex]);
            
            // Add click listeners
            document.querySelectorAll('.file-item').forEach(item => {
                item.addEventListener('click', () => {
                    selectedIndex = parseInt(item.dataset.index);
                    updateFileList();
                });
                
                item.addEventListener('dblclick', () => {
                    vscode.postMessage({
                        command: 'openFile',
                        filePath: item.dataset.path
                    });
                });
            });
        }
        
        function filterItems(query) {
            if (!query) {
                filteredItems = [...currentItems];
            } else {
                const lowerQuery = query.toLowerCase();
                filteredItems = currentItems.filter(item => 
                    item.label.toLowerCase().includes(lowerQuery) ||
                    item.description.toLowerCase().includes(lowerQuery)
                );
            }
            selectedIndex = 0;
            updateFileList();
        }
        
        searchInput.addEventListener('input', (e) => {
            filterItems(e.target.value);
        });
        
        searchInput.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (selectedIndex < filteredItems.length - 1) {
                        selectedIndex++;
                        updateFileList();
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (selectedIndex > 0) {
                        selectedIndex--;
                        updateFileList();
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (filteredItems[selectedIndex]) {
                        vscode.postMessage({
                            command: 'openFile',
                            filePath: filteredItems[selectedIndex].filePath
                        });
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    vscode.postMessage({ command: 'close' });
                    break;
            }
        });
        
        // Focus search input
        searchInput.focus();
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateItems':
                    currentItems = message.items;
                    filterItems(searchInput.value);
                    break;
            }
        });
    </script>
</body>
</html>`;
}

// Telescope webview implementation
async function showTelescopeWebview(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  workspaceFolder = workspaceFolders[0].uri.fsPath;

  // Show loading indicator
  const loadingMessage = vscode.window.setStatusBarMessage('Loading files for telescope view...');

  try {
    // Get all files
    const files = await getAllFiles(workspaceFolder);
    const searchConfig = getSearchConfig();
    const previewLines = searchConfig.previewLines;
    
    outputChannel.appendLine(`[Telescope Webview] File candidate count: ${files.length}`);

    // Get top frecency files
    const topFiles = getTopFrecencyFiles(context, files);
    
    // Build telescope items with preview
    const telescopeItems: TelescopeWebviewItem[] = await Promise.all(
      topFiles.map(async (file) => {
        const relativePath = path.relative(workspaceFolder!, file);
        const fileName = path.basename(file);
        const fileDir = path.dirname(relativePath);
        const preview = await getFilePreview(file, previewLines);
        
        return {
          label: fileName,
          description: fileDir === '.' ? '' : fileDir,
          filePath: file,
          preview: preview
        };
      })
    );

    outputChannel.appendLine(`[Telescope Webview] Showing ${telescopeItems.length} files in webview.`);

    // Create and show webview panel
    const panel = vscode.window.createWebviewPanel(
      'telescopeWebview',
      'Telescope File Browser',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getTelescopeWebviewContent(telescopeItems);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'openFile':
            try {
              await updateFileUsage(context, message.filePath);
              const document = await vscode.workspace.openTextDocument(message.filePath);
              await vscode.window.showTextDocument(document);
              panel.dispose();
            } catch (error) {
              vscode.window.showErrorMessage(`Failed to open file: ${error}`);
            }
            break;
          case 'close':
            panel.dispose();
            break;
        }
      },
      undefined,
      context.subscriptions
    );

  } catch (error) {
    vscode.window.showErrorMessage(`Failed to load telescope view: ${error}`);
    outputChannel.appendLine(`[Telescope Webview] Error: ${error}`);
  } finally {
    loadingMessage.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  let lastQuickPick: vscode.QuickPick<SearchResult> | undefined;

  // Output channel for logging
  outputChannel = vscode.window.createOutputChannel('Live Search');
  debugChannel = vscode.window.createOutputChannel('Live Search Debug');
  outputChannel.appendLine('[Live Search] Extension activated.');
  
  // Setup cache invalidation
  setupCacheInvalidation(context);

  // Status bar icon
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(search) Live Search: Ready';
  statusBarItem.tooltip = 'Click to launch Live Search';
  statusBarItem.command = 'telescopeLikeSearch.chooseScope';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Initialize file index immediately
  initializeFileIndex();
  
  // Watch for workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      outputChannel.appendLine('[Live Search] Workspace folders changed, reinitializing file index...');
      initializeFileIndex();
    })
  );
  
  // Ensure file index is disposed on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (workspaceFileIndex) {
        workspaceFileIndex.dispose();
        workspaceFileIndex = null;
      }
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.openLineFromVirtualDoc', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'telescope-results') return;

      const line = editor.selection.active.line;
      const text = editor.document.lineAt(line).text;

      const result = lastSearchResults.find(r =>
        text.includes(`Line ${r.line + 1}:`) && text.includes(r.text)
      );

      if (result) {
        const doc = await vscode.workspace.openTextDocument(result.filePath);
        const shownEditor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        const pos = new vscode.Position(result.line, 0);
        shownEditor.selection = new vscode.Selection(pos, pos);
        shownEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.openCodelensViewFromPicker', async () => {
      if (lastQuickPick) {
        lastQuickPick.hide();
        await showCodeLensView(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.startInSubfolder', async () => {
      const currentFolder = await getCurrentFileFolder();
      if (!currentFolder) return;

      workspaceFolder = currentFolder;
      lastSearchFolder = currentFolder;
      await vscode.commands.executeCommand('telescopeLikeSearch.start');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.startInSelectedFolder', async () => {
      const selectedFolder = await selectSearchFolder(context);
      if (!selectedFolder) return;

      workspaceFolder = selectedFolder;
      lastSearchFolder = selectedFolder;
      await vscode.commands.executeCommand('telescopeLikeSearch.start');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.startInFile', async () => {
      try {
        const selectedFile = await selectFileToSearch(context);
        if (!selectedFile) {
          outputChannel.appendLine('[Live Search] No file selected, not launching search-in-file picker.');
          return;
        }
        outputChannel.appendLine(`[Live Search] About to launch search-in-file picker for: ${selectedFile}`);
        await launchSearchInFileQuickPick(selectedFile);
      } catch (err) {
        outputChannel.appendLine(`[Live Search] Error in startInFile command: ${err}`);
      }
    })
  );

  // Add test command
  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.testFolderSelection', async () => {
      await testFolderSelection();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.start', async () => {
      if (!workspaceFolder) {
        workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('No workspace folder open.');
          return;
        }
      }

      const quickPick = vscode.window.createQuickPick<SearchResult>();
      lastQuickPick = quickPick;

      quickPick.placeholder = `Search content in ${path.relative(workspaceFolder, lastSearchFolder || workspaceFolder)}...`;
      quickPick.matchOnDescription = true;
      quickPick.busy = false;

      // Add folder selection button
      quickPick.buttons = [
        {
          iconPath: new vscode.ThemeIcon('folder'),
          tooltip: 'Change search folder'
        }
      ];

      quickPick.onDidTriggerButton(async () => {
        const selectedFolder = await selectSearchFolder(context);
        if (selectedFolder) {
          workspaceFolder = selectedFolder;
          lastSearchFolder = selectedFolder;
          quickPick.placeholder = `Search content in ${path.relative(workspaceFolder, selectedFolder)}...`;
          if (quickPick.value) {
            runRipgrep(quickPick.value);
          }
        }
      });

      let currentProcess: ReturnType<typeof spawn> | null = null;

      const runRipgrep = (query: string) => {
        if (currentProcess) currentProcess.kill();
        if (!query || query.length < 2) {
          quickPick.items = [];
          quickPick.busy = false;
          return;
        }

        // Check cache first
        const searchFolder = lastSearchFolder || workspaceFolder!;
        const cached = getCachedResults(query, searchFolder);
        if (cached) {
          quickPick.items = cached.length > 0 ? cached : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
          quickPick.busy = false;
          outputChannel.appendLine(`[Live Search] Using cached results: ${cached.length} items`);
          return;
        }

        quickPick.busy = true;

        const searchConfig = getSearchConfig();
        const ripgrepArgs = [
          '--vimgrep',
          '--smart-case',
          '--hidden',
          '--no-heading',
          '--color', 'never',
          '--max-count', MAX_SEARCH_RESULTS.toString(),
          '--text',
          '--max-filesize', searchConfig.maxFileSize.toString(),
          query,
          searchFolder
        ];

        // Add include/exclude patterns
        searchConfig.includePatterns.forEach(pattern => {
          ripgrepArgs.push('--glob', pattern);
        });
        searchConfig.excludePatterns.forEach(pattern => {
          ripgrepArgs.push('--glob', `!${pattern}`);
        });

        currentProcess = spawn('rg', ripgrepArgs, { 
          cwd: workspaceFolder
        });

        const results: SearchResult[] = [];
        let buffer = '';
        let updateTimer: NodeJS.Timeout | null = null;

        // Stream results for better UX
        const updateUI = () => {
          if (results.length > 0) {
            // Sort by relevance before showing
            results.sort((a, b) => {
              const score = (res: SearchResult): number => {
                const fileDepth = res.filePath.split(path.sep).length;
                const startMatch = res.text.toLowerCase().startsWith(query.toLowerCase()) ? 100 : 0;
                const substringMatch = res.text.toLowerCase().includes(query.toLowerCase()) ? 50 : 0;
                const wordCount = (res.text.toLowerCase().match(new RegExp(query.toLowerCase(), 'g')) || []).length;
                const lineScore = Math.max(30 - res.line, 0);
                const filePathScore = Math.max(20 - fileDepth, 0);
                return startMatch + substringMatch + wordCount * 10 + lineScore + filePathScore;
              };
              return score(b) - score(a);
            });
            quickPick.items = results;
          }
        };

        if (currentProcess.stdout) {
          currentProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the incomplete line in buffer

            for (const line of lines) {
              if (!line.trim()) continue;
              const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
              if (match) {
                const [, file, lineNum, text] = match;
                const trimmedText = text.trim();
                const relativePath = path.relative(workspaceFolder!, file);
                results.push({
                  label: `${relativePath}:${lineNum}`,
                  description: trimmedText.length > 80 ? trimmedText.substring(0, 77) + '...' : trimmedText,
                  detail: `${file} (Line ${lineNum})`,
                  filePath: file,
                  line: parseInt(lineNum, 10) - 1,
                  text: trimmedText
                });
              }
            }

            // Throttled UI updates for better performance
            if (!updateTimer) {
              updateTimer = setTimeout(() => {
                updateUI();
                updateTimer = null;
              }, STREAM_UPDATE_INTERVAL);
            }
          });
        }

        if (currentProcess.stderr) {
          currentProcess.stderr.on('data', (data) => {
            outputChannel.appendLine(`[Live Search] Error: ${data.toString()}`);
          });
        }

        currentProcess.on('close', (code) => {
          if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
          }

          // Process any remaining buffer
          if (buffer.trim()) {
            const match = buffer.match(/^(.+?):(\d+):\d+:(.*)$/);
            if (match) {
              const [, file, lineNum, text] = match;
              const trimmedText = text.trim();
              const relativePath = path.relative(workspaceFolder!, file);
              results.push({
                label: `${relativePath}:${lineNum}`,
                description: trimmedText.length > 80 ? trimmedText.substring(0, 77) + '...' : trimmedText,
                detail: `${file} (Line ${lineNum})`,
                filePath: file,
                line: parseInt(lineNum, 10) - 1,
                text: trimmedText
              });
            }
          }

          // Final sort by relevance
          results.sort((a, b) => {
            const score = (res: SearchResult): number => {
              const fileDepth = res.filePath.split(path.sep).length;
              const startMatch = res.text.toLowerCase().startsWith(query.toLowerCase()) ? 100 : 0;
              const substringMatch = res.text.toLowerCase().includes(query.toLowerCase()) ? 50 : 0;
              const wordCount = (res.text.toLowerCase().match(new RegExp(query.toLowerCase(), 'g')) || []).length;
              const lineScore = Math.max(30 - res.line, 0);
              const filePathScore = Math.max(20 - fileDepth, 0);
              return startMatch + substringMatch + wordCount * 10 + lineScore + filePathScore;
            };
            return score(b) - score(a);
          });

          lastSearchResults = results;
          
          // Cache results
          setCachedResults(query, searchFolder, results);
          
          outputChannel.appendLine(`[Live Search] Search complete. Results: ${results.length}, Exit code: ${code}`);

          quickPick.items = results.length > 0
            ? results
            : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
          quickPick.busy = false;
        });

        currentProcess.on('error', (error) => {
          outputChannel.appendLine(`[Live Search] Process error: ${error.message}`);
          quickPick.busy = false;
          quickPick.items = [{ label: 'Search error occurred', description: error.message, detail: '', filePath: '', line: -1, text: '' }];
        });
      };

      const debouncedSearch = debounce(runRipgrep, SEARCH_DEBOUNCE_MS);
      quickPick.onDidChangeValue(debouncedSearch);

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (selected && selected.line >= 0) {
          const doc = await vscode.workspace.openTextDocument(selected.filePath);
          const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          const pos = new vscode.Position(selected.line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
        quickPick.hide();
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        // Reset workspace folder to root after search is done
        workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      });
      
      quickPick.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.clearCache', async () => {
      const searchCacheSize = searchCache.size;
      searchCache.clear();
      fileCache.clear();
      vscode.window.showInformationMessage(`Live Search: All caches cleared (${searchCacheSize} search entries removed)`);
      outputChannel.appendLine('[Live Search] All caches manually cleared');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.filePicker', async () => {
      await showFilePickerWithPreview(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.telescopeWebview', async () => {
      await showTelescopeWebview(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.chooseScope', async () => {
      const options = [
        {
          label: 'Search in whole workspace',
          description: 'Search across all files in the workspace',
          command: 'telescopeLikeSearch.start'
        },
        {
          label: 'Select folder to search in',
          description: 'Choose a folder to limit the search',
          command: 'telescopeLikeSearch.startInSelectedFolder'
        },
        {
          label: 'Select file to search in',
          description: 'Choose a file to limit the search',
          command: 'telescopeLikeSearch.startInFile'
        },
        {
          label: 'File picker with preview',
          description: 'Browse and open files with instant content preview',
          command: 'telescopeLikeSearch.filePicker'
        },
        {
          label: 'Telescope-style file browser',
          description: 'Browse files with two-sidebar layout and line wrapping',
          command: 'telescopeLikeSearch.telescopeWebview'
        }
      ];
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Choose search scope',
        matchOnDescription: true
      });
      if (selected) {
        await vscode.commands.executeCommand(selected.command);
      }
    })
  );
}

export function deactivate() { }

class GroupedCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private lensData: { line: number, result: SearchResult }[]) { }

  provideCodeLenses(): vscode.CodeLens[] {
    return this.lensData.map(({ line, result }) => {
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: `🔗 Open ${path.basename(result.filePath)}:${result.line + 1}`,
        command: 'vscode.open',
        arguments: [
          vscode.Uri.file(result.filePath),
          { selection: new vscode.Range(result.line, 0, result.line, 0) }
        ]
      });
    });
  }
}

function getGitignorePatterns(): string[] {
  try {
    const gitignorePath = path.join(workspaceFolder!, '.gitignore');
    const gitignoreContent = vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
    const patterns = gitignoreContent.toString().split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line && !line.startsWith('#'))
      .map((line: string) => {
        // Convert .gitignore patterns to glob patterns
        if (line.startsWith('/')) {
          return `**${line}/**`;
        }
        if (line.endsWith('/')) {
          return `**/${line}**`;
        }
        return `**/${line}`;
      });
    return patterns;
  } catch {
    return [];
  }
}