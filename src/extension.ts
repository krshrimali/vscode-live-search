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
const SEARCH_DEBOUNCE_MS = 300;

// Configuration for search scope
interface SearchConfig {
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;
  recentFolders: string[];
  maxItemsInPicker: number;
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
    maxItemsInPicker: config.get('maxItemsInPicker', 30)
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

// Use the in-memory index for file picker
async function getAllFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  
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
        const fullPath = path.join(dir, name);
        const relativePath = path.relative(rootPath, fullPath);
        
        // Skip if the path matches any ignore patterns
        if (ig.ignores(relativePath)) {
          continue;
        }

        if (type === vscode.FileType.Directory) {
          await scanDirectory(fullPath);
        } else if (type === vscode.FileType.File) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
    }
  }

  await scanDirectory(rootPath);
  return files;
}

async function selectFileToSearch(context: vscode.ExtensionContext): Promise<string | undefined> {
  outputChannel.appendLine('[Live Search] Opening file picker...');
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folders open.');
    outputChannel.appendLine('[Live Search] No workspace folders open.');
    return undefined;
  }
  workspaceFolder = workspaceFolders[0].uri.fsPath;

  // Show loading indicator
  const loadingMessage = vscode.window.setStatusBarMessage('Loading files...');

  try {
    // Get all files
    const files = await getAllFiles(workspaceFolder);
    outputChannel.appendLine(`[Live Search] File picker candidate count: ${files.length}`);

    // Helper to build fileItems for a given list of files
    async function buildFileItems(fileList: string[]): Promise<FileQuickPickItem[]> {
      return Promise.all(fileList.map(async file => {
        const relativePath = path.relative(workspaceFolder!, file);
        const fileName = path.basename(file);
        const fileDir = path.dirname(relativePath);

        return {
          label: fileName,
          description: fileDir === '.' ? '' : fileDir,
          filePath: file
        };
      }));
    }

    // Get top frecency files
    const maxItems = getSearchConfig().maxItemsInPicker;
    const topFiles = getTopFrecencyFiles(context, files);
    let fileItems = await buildFileItems(topFiles);
    outputChannel.appendLine(`[Live Search] Showing top ${fileItems.length} files in picker.`);

    const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
    quickPick.items = fileItems;
    quickPick.placeholder = 'Select file to search in';
    quickPick.matchOnDescription = true;
    quickPick.busy = false;

    quickPick.onDidChangeValue(async (value) => {
      if (!value) {
        quickPick.items = await buildFileItems(getTopFrecencyFiles(context, files));
        outputChannel.appendLine('[Live Search] Picker reset to top frecency files.');
        return;
      }

      // Filter files by value (case-insensitive substring match)
      // Match against both filename and relative path
      const filtered = files.filter(f => {
        const relativePath = path.relative(workspaceFolder!, f);
        return relativePath.toLowerCase().includes(value.toLowerCase());
      });

      quickPick.items = await buildFileItems(filtered.slice(0, maxItems));
      outputChannel.appendLine(`[Live Search] Picker filtered: ${filtered.length} matches, showing ${Math.min(filtered.length, maxItems)}.`);
    });

    return new Promise<string | undefined>((resolve) => {
      let resolved = false;
      quickPick.onDidAccept(async () => {
        if (resolved) return;
        resolved = true;
        const selected = quickPick.selectedItems[0];
        quickPick.hide();
        if (selected?.filePath) {
          await updateFileUsage(context, selected.filePath);
          outputChannel.appendLine(`[Live Search] File selected: ${selected.filePath}`);
          resolve(selected.filePath);
        } else {
          outputChannel.appendLine('[Live Search] File picker accepted, but no file selected.');
          resolve(undefined);
        }
      });
      quickPick.onDidHide(() => {
        if (resolved) return;
        resolved = true;
        outputChannel.appendLine('[Live Search] File picker closed.');
        resolve(undefined);
      });
      quickPick.show();
    });
  } finally {
    loadingMessage.dispose();
  }
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

    quickPick.busy = true;
    let buffer = '';
    outputChannel.appendLine(`[Live Search] Running ripgrep in file: ${selectedFile} | Query: "${query}"`);

    // Split the file into chunks for parallel processing
    const CHUNK_SIZE = 1000; // Number of lines per chunk
    const chunks: string[] = [];
    let currentChunk = '';
    let lineCount = 0;

    const processChunk = async (chunk: string, startLine: number): Promise<SearchResult[]> => {
      const ripgrepArgs = [
        '--vimgrep',
        '--smart-case',
        '--no-heading',
        '--color', 'never',
        '--text',
        '--line-number',
        '--with-filename',
        query,
        '-'
      ];

      return new Promise((resolve) => {
        const process: ReturnType<typeof spawn> = spawn('rg', ripgrepArgs, { 
          cwd: workspaceFolder
        });

        let chunkBuffer = '';
        if (process.stdout) {
          process.stdout.on('data', (data) => chunkBuffer += data.toString());
        }

        process.on('close', () => {
          const lines = chunkBuffer.split('\n');
          const results: SearchResult[] = [];

          for (const line of lines) {
            if (!line.trim()) continue;
            const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
            if (match) {
              const [, file, lineNum, text] = match;
              results.push({
                label: `Line ${lineNum}`,
                description: text.trim(),
                filePath: file,
                line: parseInt(lineNum, 10) - 1,
                text: text.trim()
              });
            }
          }
          resolve(results);
        });

        process.stdin?.write(chunk);
        process.stdin?.end();
      });
    };

    // Read file in chunks and process them
    const fileStream = fs.createReadStream(selectedFile, { encoding: 'utf8' });
    const rl = require('readline').createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    rl.on('line', (line: string) => {
      currentChunk += line + '\n';
      lineCount++;
      
      if (lineCount >= CHUNK_SIZE) {
        chunks.push(currentChunk);
        currentChunk = '';
        lineCount = 0;
      }
    });

    rl.on('close', async () => {
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      // Process chunks in parallel
      const chunkResults = await Promise.all(
        chunks.map((chunk, index) => 
          processChunk(chunk, index * CHUNK_SIZE)
        )
      );

      // Combine and sort results
      const results = chunkResults.flat().sort((a, b) => a.line - b.line);
      lastSearchResults = results;
      outputChannel.appendLine(`[Live Search] Search complete. Results: ${results.length}`);

      quickPick.items = results.length > 0
        ? results
        : [{ label: 'No matches found', description: '', filePath: '', line: -1, text: '' }];
      quickPick.busy = false;
    });

    // Set a timeout to show results even if some chunks are still processing
    searchTimeout = setTimeout(() => {
      if (quickPick.busy) {
        quickPick.busy = false;
        outputChannel.appendLine('[Live Search] Search timed out, showing partial results.');
      }
    }, 5000); // 5 second timeout
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

export async function activate(context: vscode.ExtensionContext) {
  let lastQuickPick: vscode.QuickPick<SearchResult> | undefined;

  // Output channel for logging
  outputChannel = vscode.window.createOutputChannel('Live Search');
  debugChannel = vscode.window.createOutputChannel('Live Search Debug');
  outputChannel.appendLine('[Live Search] Extension activated.');

  // Status bar icon
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(search) Live Search: Ready';
  statusBarItem.tooltip = 'Click to launch Live Search';
  statusBarItem.command = 'telescopeLikeSearch.chooseScope';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Initialize workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    workspaceFolder = workspaceFolders[0].uri.fsPath;
    // Remove indexing logic
    // vscode.window.withProgress(
    //   {
    //     location: vscode.ProgressLocation.Window,
    //     title: 'Live Search: Indexing workspace...',
    //     cancellable: false
    //   },
    //   async (progress) => {
    //     statusBarItem.text = '$(sync~spin) Live Search: Indexing...';
    //     statusBarItem.tooltip = 'Indexing workspace for Live Search...';
    //     statusBarItem.command = undefined;
    //     const { folderIndex: fIdx, fileIndex: fiIdx } = await buildIndexesParallel(workspaceFolder!, progress);
    //     folderIndex = fIdx;
    //     fileIndex = fiIdx;
    //   }
    // ).then(() => {
    //   vscode.window.setStatusBarMessage('Live Search: Indexing complete!', 3000);
    //   statusBarItem.text = '$(search) Live Search: Ready';
    //   statusBarItem.tooltip = 'Click to launch Live Search';
    //   statusBarItem.command = 'telescopeLikeSearch.chooseScope';
    // });
    // setupIndexWatchers(context, workspaceFolder);
  }

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

        quickPick.busy = true;
        let buffer = '';

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
          workspaceFolder!
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

        if (currentProcess.stdout) {
          currentProcess.stdout.on('data', (data) => buffer += data.toString());
        }

        currentProcess.on('close', () => {
          const lines = buffer.split('\n');
          const results: SearchResult[] = [];
          const processedFiles = new Set<string>();

          for (const line of lines) {
            if (!line.trim()) continue;
            const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
            if (match) {
              const [, file, lineNum, text] = match;
              if (processedFiles.has(file)) continue;
              processedFiles.add(file);

              results.push({
                label: `${path.relative(workspaceFolder!, file)}:${lineNum}`,
                description: text.trim(),
                detail: file,
                filePath: file,
                line: parseInt(lineNum, 10) - 1,
                text: text.trim()
              });
            }
          }

          // Heuristic sorting by relevance
          results.sort((a, b) => {
            const score = (res: SearchResult): number => {
              const fileDepth = res.filePath.split(path.sep).length;
              const startMatch = res.text.toLowerCase().startsWith(query.toLowerCase()) ? 100 : 0;
              const substringMatch = res.text.toLowerCase().includes(query.toLowerCase()) ? 50 : 0;
              const wordCount =  (res.text.toLowerCase().match(new RegExp(query.toLowerCase(), 'g')) || []).length;
              const lineScore = Math.max(30 - res.line, 0);
              const filePathScore = Math.max(20 - fileDepth, 0);
              return startMatch + substringMatch + wordCount * 10 + lineScore + filePathScore;
            };

            return score(b) - score(a);
          });

          lastSearchResults = results;

          quickPick.items = results.length > 0
            ? results
            : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
          quickPick.busy = false;
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