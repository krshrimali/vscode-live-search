import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import debounce from 'lodash.debounce';
import * as minimatch from 'minimatch';

interface SearchResult extends vscode.QuickPickItem {
  filePath: string;
  line: number;
  text: string;
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
    recentFolders: config.get('recentFolders', [])
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

let gitignorePatterns: string[] = [];
let gitignoreMatchers: minimatch.Minimatch[] = [];

async function loadGitignorePatterns(root: string) {
  gitignorePatterns = [];
  gitignoreMatchers = [];
  try {
    const gitignorePath = path.join(root, '.gitignore');
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
    const lines = content.toString().split('\n');
    gitignorePatterns = lines
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    gitignoreMatchers = gitignorePatterns.map(pattern => new minimatch.Minimatch(pattern, { dot: true, matchBase: true }));
  } catch {
    // No .gitignore, ignore
  }
}

function isIgnoredByGitignore(relPath: string): boolean {
  return gitignoreMatchers.some(matcher => matcher.match(relPath));
}

async function buildIndexes(root: string, progress?: vscode.Progress<{ message?: string; increment?: number }>) {
  folderIndex = [];
  fileIndex = [];
  await loadGitignorePatterns(root);
  let folderCount = 0;
  let fileCount = 0;
  async function walk(dir: string) {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const fullPath = path.join(dir, name);
      const relPath = path.relative(root, fullPath);
      if (isIgnoredByGitignore(relPath)) continue;
      if (type === vscode.FileType.Directory) {
        folderIndex.push(fullPath);
        folderCount++;
        if (progress && folderCount % 50 === 0) {
          progress.report({ message: `Indexed ${folderCount} folders, ${fileCount} files...` });
        }
        await walk(fullPath);
      } else if (type === vscode.FileType.File) {
        fileIndex.push(fullPath);
        fileCount++;
        if (progress && fileCount % 200 === 0) {
          progress.report({ message: `Indexed ${folderCount} folders, ${fileCount} files...` });
        }
      }
    }
  }
  await walk(root);
  if (progress) {
    progress.report({ message: `Indexing complete: ${folderCount} folders, ${fileCount} files.` });
  }
}

function setupIndexWatchers(context: vscode.ExtensionContext, root: string) {
  // Listen for file/folder create/delete/rename events
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const refresh = () => buildIndexes(root);
  watcher.onDidCreate(refresh, null, context.subscriptions);
  watcher.onDidDelete(refresh, null, context.subscriptions);
  watcher.onDidChange(refresh, null, context.subscriptions); // for renames
  context.subscriptions.push(watcher);
  // Watch .gitignore
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  gitignoreWatcher.onDidChange(refresh, null, context.subscriptions);
  gitignoreWatcher.onDidCreate(refresh, null, context.subscriptions);
  gitignoreWatcher.onDidDelete(refresh, null, context.subscriptions);
  context.subscriptions.push(gitignoreWatcher);
}

// Use the in-memory index for subfolder listing
async function getSubfolders(folderPath: string): Promise<string[]> {
  // Only return subfolders that are direct or nested children of folderPath
  return folderIndex.filter(f => f.startsWith(folderPath) && f !== folderPath);
}

async function selectSearchFolder(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folders open.');
    return undefined;
  }

  workspaceFolder = workspaceFolders[0].uri.fsPath;

  // Use getSubfolders to get all subfolders recursively
  const folders = await getSubfolders(workspaceFolder);
  // Add the root folder as the first option
  const items = [
    {
      label: 'Current Folder',
      description: workspaceFolder,
      detail: `📁 ${workspaceFolder}`
    },
    ...folders.map(folder => ({
      label: path.relative(workspaceFolder!, folder),
      description: folder,
      detail: `📁 ${folder}`
    }))
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select folder to search in',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selected) {
    updateRecentFolders(selected.description!);
    return selected.description;
  }
  return undefined;
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

// Use the in-memory index for file picker
async function selectFileToSearch(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folders open.');
    return undefined;
  }
  workspaceFolder = workspaceFolders[0].uri.fsPath;

  // Use the in-memory file index
  const files = fileIndex.filter(f => !f.includes('node_modules'));
  const fileItems = await Promise.all(files.map(async file => {
    const relativePath = path.relative(workspaceFolder!, file);
    let preview = '';
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const text = content.toString();
      preview = text.split('\n').slice(0, 3).join('\n');
    } catch {
      preview = '[Unable to read file]';
    }
    return {
      label: relativePath,
      description: file,
      detail: preview
    };
  }));

  const selected = await vscode.window.showQuickPick(
    fileItems,
    {
      placeHolder: 'Select file to search in',
      matchOnDescription: true
    }
  );
  return selected?.description;
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

export function activate(context: vscode.ExtensionContext) {
  let lastQuickPick: vscode.QuickPick<SearchResult> | undefined;

  // Initialize workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    workspaceFolder = workspaceFolders[0].uri.fsPath;
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Live Search: Indexing workspace...',
        cancellable: false
      },
      async (progress) => {
        await buildIndexes(workspaceFolder!, progress);
      }
    ).then(() => {
      vscode.window.setStatusBarMessage('Live Search: Indexing complete!', 3000);
    });
    setupIndexWatchers(context, workspaceFolder);
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
      const selectedFolder = await selectSearchFolder();
      if (!selectedFolder) return;

      workspaceFolder = selectedFolder;
      lastSearchFolder = selectedFolder;
      await vscode.commands.executeCommand('telescopeLikeSearch.start');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.startInFile', async () => {
      const selectedFile = await selectFileToSearch();
      if (!selectedFile) return;

      const quickPick = vscode.window.createQuickPick<SearchResult>();
      lastQuickPick = quickPick;

      quickPick.placeholder = `Search content in ${path.basename(selectedFile)}...`;
      quickPick.matchOnDescription = true;
      quickPick.busy = false;

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

        const ripgrepArgs = [
          '--vimgrep',
          '--smart-case',
          '--no-heading',
          '--color', 'never',
          '--text',
          query,
          selectedFile
        ];

        currentProcess = spawn('rg', ripgrepArgs, { 
          cwd: workspaceFolder
        });

        if (currentProcess.stdout) {
          currentProcess.stdout.on('data', (data) => buffer += data.toString());
        }

        currentProcess.on('close', () => {
          const lines = buffer.split('\n');
          const results: SearchResult[] = [];

          for (const line of lines) {
            if (!line.trim()) continue;
            const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
            if (match) {
              const [, file, lineNum, text] = match;
              results.push({
                label: `Line ${lineNum}`,
                description: text.trim(),
                detail: file,
                filePath: file,
                line: parseInt(lineNum, 10) - 1,
                text: text.trim()
              });
            }
          }

          // Sort by line number
          results.sort((a, b) => a.line - b.line);

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
        workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      });
      
      quickPick.show();
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
        const selectedFolder = await selectSearchFolder();
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