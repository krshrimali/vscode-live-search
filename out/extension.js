"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const lodash_debounce_1 = __importDefault(require("lodash.debounce"));
const ignore_1 = __importDefault(require("ignore"));
let lastSearchResults = [];
let workspaceFolder;
let lastSearchFolder;
const PREVIEW_LINE_CONTEXT = 2;
const MAX_SEARCH_RESULTS = 300;
const SEARCH_DEBOUNCE_MS = 300;
function getSearchConfig() {
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
function updateRecentFolders(folder) {
    const config = vscode.workspace.getConfiguration('telescopeLikeSearch');
    const recentFolders = config.get('recentFolders', []);
    const updatedFolders = [folder, ...recentFolders.filter(f => f !== folder)].slice(0, 5);
    config.update('recentFolders', updatedFolders, true);
}
function isDirectory(uri) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const stat = yield vscode.workspace.fs.stat(uri);
            return (stat.type & vscode.FileType.Directory) !== 0;
        }
        catch (_a) {
            return false;
        }
    });
}
// In-memory indexes
let folderIndex = [];
let fileIndex = [];
let gitignoreMatcher = null;
function loadGitignorePatterns(root) {
    return __awaiter(this, void 0, void 0, function* () {
        gitignoreMatcher = (0, ignore_1.default)();
        try {
            const gitignorePath = path.join(root, '.gitignore');
            const content = yield vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
            const lines = content.toString().split('\n');
            gitignoreMatcher.add(lines);
        }
        catch (_a) {
            // No .gitignore, ignore
        }
    });
}
function isIgnoredByGitignore(relPath) {
    return gitignoreMatcher ? gitignoreMatcher.ignores(relPath) : false;
}
let outputChannel;
let debugChannel;
let statusBarItem;
// Use the in-memory index for subfolder listing
function getSubfolders(folderPath) {
    return __awaiter(this, void 0, void 0, function* () {
        // Only return subfolders that are direct or nested children of folderPath
        return folderIndex.filter(f => f.startsWith(folderPath) && f !== folderPath);
    });
}
function getAllSubfolders(rootPath) {
    return __awaiter(this, void 0, void 0, function* () {
        const folders = [];
        // Initialize gitignore matcher
        const ig = (0, ignore_1.default)();
        try {
            const gitignorePath = path.join(rootPath, '.gitignore');
            const content = yield vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
            const lines = content.toString().split('\n');
            ig.add(lines);
        }
        catch (_a) {
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
        function scanDirectory(dir) {
            return __awaiter(this, void 0, void 0, function* () {
                try {
                    const entries = yield vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
                    for (const [name, type] of entries) {
                        if (type === vscode.FileType.Directory) {
                            const fullPath = path.join(dir, name);
                            const relativePath = path.relative(rootPath, fullPath);
                            // Skip if the folder matches any ignore patterns
                            if (ig.ignores(relativePath)) {
                                continue;
                            }
                            folders.push(fullPath);
                            yield scanDirectory(fullPath);
                        }
                    }
                }
                catch (error) {
                    console.error(`Error scanning directory ${dir}:`, error);
                }
            });
        }
        yield scanDirectory(rootPath);
        return folders;
    });
}
function getFolderUsageMap(context) {
    return context.workspaceState.get('liveSearchFolderUsage', {});
}
function updateFolderUsage(context, folder) {
    return __awaiter(this, void 0, void 0, function* () {
        const usage = getFolderUsageMap(context);
        const now = Date.now();
        if (!usage[folder])
            usage[folder] = { freq: 0, last: 0 };
        usage[folder].freq += 1;
        usage[folder].last = now;
        yield context.workspaceState.update('liveSearchFolderUsage', usage);
    });
}
function selectSearchFolder(context) {
    return __awaiter(this, void 0, void 0, function* () {
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
        const ig = (0, ignore_1.default)();
        try {
            const gitignorePath = path.join(workspaceFolder, '.gitignore');
            const content = yield vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
            const lines = content.toString().split('\n');
            ig.add(lines);
        }
        catch (_a) {
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
        function scanFolders(dir, depth, searchTerm) {
            return __awaiter(this, void 0, void 0, function* () {
                if (depth > MAX_DEPTH)
                    return [];
                const folders = [];
                try {
                    const entries = yield vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
                    for (const [name, type] of entries) {
                        if (type === vscode.FileType.Directory) {
                            const fullPath = path.join(dir, name);
                            const relativePath = path.relative(workspaceFolder, fullPath);
                            // Skip if the folder matches any ignore patterns
                            if (ig.ignores(relativePath)) {
                                continue;
                            }
                            // Only add if it matches the search term
                            if (!searchTerm || relativePath.toLowerCase().includes(searchTerm.toLowerCase())) {
                                folders.push(fullPath);
                            }
                            // Only recurse if we haven't hit the folder limit
                            if (folders.length < MAX_FOLDERS) {
                                const subFolders = yield scanFolders(fullPath, depth + 1, searchTerm);
                                folders.push(...subFolders);
                            }
                        }
                    }
                }
                catch (error) {
                    console.error(`Error scanning directory ${dir}:`, error);
                }
                return folders.slice(0, MAX_FOLDERS);
            });
        }
        quickPick.onDidChangeValue((value) => __awaiter(this, void 0, void 0, function* () {
            if (isSearching)
                return;
            isSearching = true;
            quickPick.busy = true;
            try {
                if (!value) {
                    quickPick.items = [rootItem];
                    return;
                }
                const folders = yield scanFolders(workspaceFolder, 0, value);
                const items = folders.map(folder => ({
                    label: path.relative(workspaceFolder, folder),
                    description: folder,
                    detail: `📁 ${folder}`
                }));
                quickPick.items = [rootItem, ...items];
            }
            finally {
                quickPick.busy = false;
                isSearching = false;
            }
        }));
        return new Promise((resolve) => {
            let resolved = false;
            quickPick.onDidAccept(() => {
                if (resolved)
                    return;
                resolved = true;
                const selected = quickPick.selectedItems[0];
                quickPick.hide();
                if (selected === null || selected === void 0 ? void 0 : selected.description) {
                    updateFolderUsage(context, selected.description);
                    resolve(selected.description);
                }
                else {
                    resolve(undefined);
                }
            });
            quickPick.onDidHide(() => {
                if (resolved)
                    return;
                resolved = true;
                resolve(undefined);
            });
            quickPick.show();
        });
    });
}
function testFolderSelection() {
    return __awaiter(this, void 0, void 0, function* () {
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder is open');
            return;
        }
        // At this point we know workspaceFolder is defined
        const rootFolder = workspaceFolder;
        const folders = yield getSubfolders(rootFolder);
        console.log('Available folders:', folders);
        const items = folders.map(folder => {
            const relativePath = path.relative(rootFolder, folder);
            return {
                label: relativePath,
                description: folder,
                detail: `📁 ${folder}`
            };
        });
        const selected = yield vscode.window.showQuickPick(items, {
            placeHolder: 'Select a folder to search in',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (selected) {
            console.log('Selected folder:', selected.description);
            vscode.window.showInformationMessage(`Selected folder: ${selected.description}`);
        }
    });
}
function getFileUsageMap(context) {
    return context.workspaceState.get('liveSearchFileUsage', {});
}
function updateFileUsage(context, file) {
    return __awaiter(this, void 0, void 0, function* () {
        const usage = getFileUsageMap(context);
        const now = Date.now();
        if (!usage[file])
            usage[file] = { freq: 0, last: 0 };
        usage[file].freq += 1;
        usage[file].last = now;
        yield context.workspaceState.update('liveSearchFileUsage', usage);
    });
}
function getTopFrecencyFiles(context, files, limit) {
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
function getTopFrecencyFolders(context, folders, limit) {
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
function getAllFiles(rootPath) {
    return __awaiter(this, void 0, void 0, function* () {
        const files = [];
        // Initialize gitignore matcher
        const ig = (0, ignore_1.default)();
        try {
            const gitignorePath = path.join(rootPath, '.gitignore');
            const content = yield vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
            const lines = content.toString().split('\n');
            ig.add(lines);
        }
        catch (_a) {
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
        function scanDirectory(dir) {
            return __awaiter(this, void 0, void 0, function* () {
                try {
                    const entries = yield vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
                    for (const [name, type] of entries) {
                        const fullPath = path.join(dir, name);
                        const relativePath = path.relative(rootPath, fullPath);
                        // Skip if the path matches any ignore patterns
                        if (ig.ignores(relativePath)) {
                            continue;
                        }
                        if (type === vscode.FileType.Directory) {
                            yield scanDirectory(fullPath);
                        }
                        else if (type === vscode.FileType.File) {
                            files.push(fullPath);
                        }
                    }
                }
                catch (error) {
                    console.error(`Error scanning directory ${dir}:`, error);
                }
            });
        }
        yield scanDirectory(rootPath);
        return files;
    });
}
function selectFileToSearch(context) {
    return __awaiter(this, void 0, void 0, function* () {
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
            const files = yield getAllFiles(workspaceFolder);
            outputChannel.appendLine(`[Live Search] File picker candidate count: ${files.length}`);
            // Helper to build fileItems for a given list of files
            function buildFileItems(fileList) {
                return __awaiter(this, void 0, void 0, function* () {
                    return Promise.all(fileList.map((file) => __awaiter(this, void 0, void 0, function* () {
                        const relativePath = path.relative(workspaceFolder, file);
                        const fileName = path.basename(file);
                        const fileDir = path.dirname(relativePath);
                        let preview = '';
                        try {
                            const content = yield vscode.workspace.fs.readFile(vscode.Uri.file(file));
                            const text = content.toString();
                            preview = text.split('\n').slice(0, 3).join('\n');
                        }
                        catch (_a) {
                            preview = '[Unable to read file]';
                        }
                        return {
                            label: fileName,
                            description: fileDir === '.' ? '' : fileDir,
                            detail: preview,
                            filePath: file
                        };
                    })));
                });
            }
            // Get top frecency files
            const maxItems = getSearchConfig().maxItemsInPicker;
            const topFiles = getTopFrecencyFiles(context, files);
            let fileItems = yield buildFileItems(topFiles);
            outputChannel.appendLine(`[Live Search] Showing top ${fileItems.length} files in picker.`);
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = fileItems;
            quickPick.placeholder = 'Select file to search in';
            quickPick.matchOnDescription = true;
            quickPick.busy = false;
            quickPick.onDidChangeValue((value) => __awaiter(this, void 0, void 0, function* () {
                if (!value) {
                    quickPick.items = yield buildFileItems(getTopFrecencyFiles(context, files));
                    outputChannel.appendLine('[Live Search] Picker reset to top frecency files.');
                    return;
                }
                // Filter files by value (case-insensitive substring match)
                // Match against both filename and relative path
                const filtered = files.filter(f => {
                    const relativePath = path.relative(workspaceFolder, f);
                    return relativePath.toLowerCase().includes(value.toLowerCase());
                });
                quickPick.items = yield buildFileItems(filtered.slice(0, maxItems));
                outputChannel.appendLine(`[Live Search] Picker filtered: ${filtered.length} matches, showing ${Math.min(filtered.length, maxItems)}.`);
            }));
            return new Promise((resolve) => {
                let resolved = false;
                quickPick.onDidAccept(() => __awaiter(this, void 0, void 0, function* () {
                    if (resolved)
                        return;
                    resolved = true;
                    const selected = quickPick.selectedItems[0];
                    quickPick.hide();
                    if (selected === null || selected === void 0 ? void 0 : selected.filePath) {
                        yield updateFileUsage(context, selected.filePath);
                        outputChannel.appendLine(`[Live Search] File selected: ${selected.filePath}`);
                        resolve(selected.filePath);
                    }
                    else {
                        outputChannel.appendLine('[Live Search] File picker accepted, but no file selected.');
                        resolve(undefined);
                    }
                }));
                quickPick.onDidHide(() => {
                    if (resolved)
                        return;
                    resolved = true;
                    outputChannel.appendLine('[Live Search] File picker closed.');
                    resolve(undefined);
                });
                quickPick.show();
            });
        }
        finally {
            loadingMessage.dispose();
        }
    });
}
function getCurrentFileFolder() {
    return __awaiter(this, void 0, void 0, function* () {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor.');
            return undefined;
        }
        const filePath = editor.document.uri.fsPath;
        return path.dirname(filePath);
    });
}
function showCodeLensView(context) {
    return __awaiter(this, void 0, void 0, function* () {
        const grouped = {};
        for (const res of lastSearchResults) {
            if (!grouped[res.filePath])
                grouped[res.filePath] = [];
            grouped[res.filePath].push(res);
        }
        const lines = [];
        const lensMap = [];
        // Process files in parallel with a limit
        const processFile = (file, results) => __awaiter(this, void 0, void 0, function* () {
            const fileLines = [];
            fileLines.push(`📁 ${file}`);
            for (const res of results) {
                const lineNum = lines.length + fileLines.length;
                lensMap.push({ line: lineNum, result: res });
                fileLines.push(`   → Line ${res.line + 1}: ${res.text}`);
                try {
                    const doc = yield vscode.workspace.openTextDocument(res.filePath);
                    const start = Math.max(0, res.line - 1);
                    const end = Math.min(doc.lineCount, res.line + 2);
                    const contextLines = doc.getText(new vscode.Range(start, 0, end, 0)).split('\n');
                    for (const ctxLine of contextLines) {
                        fileLines.push(`      ${ctxLine}`);
                    }
                    fileLines.push('');
                }
                catch (_a) {
                    fileLines.push('      [Unable to preview context]', '');
                }
            }
            fileLines.push('');
            return fileLines;
        });
        // Process files in batches to avoid overwhelming the system
        const batchSize = 10; // Increased batch size for better performance
        const files = Object.entries(grouped);
        // Show loading indicator
        const loadingMessage = vscode.window.setStatusBarMessage('Loading search results...');
        try {
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                const batchResults = yield Promise.all(batch.map(([file, results]) => processFile(file, results)));
                lines.push(...batchResults.flat());
                // Update progress
                const progress = Math.min(100, Math.round((i + batchSize) / files.length * 100));
                loadingMessage.dispose();
                vscode.window.setStatusBarMessage(`Loading search results... ${progress}%`);
            }
        }
        finally {
            loadingMessage.dispose();
        }
        const content = lines.join('\n');
        const uri = vscode.Uri.parse('telescope-results:/results');
        const provider = new (class {
            provideTextDocumentContent() {
                return content;
            }
        })();
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('telescope-results', provider));
        context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'telescope-results' }, new GroupedCodeLensProvider(lensMap)), vscode.languages.registerHoverProvider({ scheme: 'telescope-results' }, {
            provideHover(document, position) {
                return __awaiter(this, void 0, void 0, function* () {
                    const lineText = document.lineAt(position.line).text;
                    const match = lineText.match(/Line (\d+): (.+)/);
                    if (!match)
                        return;
                    const lineNumber = parseInt(match[1], 10) - 1;
                    const matchedText = match[2].trim();
                    const result = lastSearchResults.find(r => r.line === lineNumber && r.text === matchedText);
                    if (!result)
                        return;
                    try {
                        const doc = yield vscode.workspace.openTextDocument(result.filePath);
                        const contextLine = doc.lineAt(result.line).text;
                        return new vscode.Hover(new vscode.MarkdownString(`**Preview from 📄 ${path.basename(result.filePath)}:${result.line + 1}**\n\n\`${contextLine.trim()}\``));
                    }
                    catch (_a) {
                        return new vscode.Hover('⚠️ Unable to load preview');
                    }
                });
            }
        }), vscode.languages.registerFoldingRangeProvider({ scheme: 'telescope-results' }, {
            provideFoldingRanges(document) {
                const ranges = [];
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
        }));
        const doc = yield vscode.workspace.openTextDocument(uri);
        yield vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    });
}
// Helper to launch search-in-file QuickPick for a given file
function launchSearchInFileQuickPick(selectedFile) {
    return __awaiter(this, void 0, void 0, function* () {
        outputChannel.appendLine(`[Live Search] Launching search-in-file picker for: ${selectedFile}`);
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = `Search content in ${path.basename(selectedFile)}...`;
        quickPick.matchOnDescription = true;
        quickPick.busy = false;
        let currentProcess = null;
        const runRipgrep = (query) => {
            if (currentProcess)
                currentProcess.kill();
            if (!query || query.length < 2) {
                quickPick.items = [];
                quickPick.busy = false;
                outputChannel.appendLine('[Live Search] Search query too short or empty.');
                return;
            }
            quickPick.busy = true;
            let buffer = '';
            outputChannel.appendLine(`[Live Search] Running ripgrep in file: ${selectedFile} | Query: "${query}"`);
            const ripgrepArgs = [
                '--vimgrep',
                '--smart-case',
                '--no-heading',
                '--color', 'never',
                '--text',
                query,
                selectedFile
            ];
            currentProcess = (0, child_process_1.spawn)('rg', ripgrepArgs, {
                cwd: workspaceFolder
            });
            if (currentProcess.stdout) {
                currentProcess.stdout.on('data', (data) => buffer += data.toString());
            }
            currentProcess.on('close', () => {
                const lines = buffer.split('\n');
                const results = [];
                for (const line of lines) {
                    if (!line.trim())
                        continue;
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
                outputChannel.appendLine(`[Live Search] Search complete. Results: ${results.length}`);
                quickPick.items = results.length > 0
                    ? results
                    : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
                quickPick.busy = false;
            });
            currentProcess.on('error', (err) => {
                outputChannel.appendLine(`[Live Search] Ripgrep process error: ${err}`);
            });
        };
        const debouncedSearch = (0, lodash_debounce_1.default)(runRipgrep, SEARCH_DEBOUNCE_MS);
        quickPick.onDidChangeValue(debouncedSearch);
        quickPick.onDidAccept(() => __awaiter(this, void 0, void 0, function* () {
            const selected = quickPick.selectedItems[0];
            if (selected && selected.line >= 0) {
                outputChannel.appendLine(`[Live Search] Opening file at line: ${selected.line + 1}`);
                const doc = yield vscode.workspace.openTextDocument(selected.filePath);
                const editor = yield vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                const pos = new vscode.Position(selected.line, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
            else {
                outputChannel.appendLine('[Live Search] Search-in-file picker accepted, but no result selected.');
            }
            quickPick.hide();
        }));
        quickPick.onDidHide(() => {
            var _a, _b;
            outputChannel.appendLine('[Live Search] Search-in-file picker closed.');
            quickPick.dispose();
            workspaceFolder = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
        });
        quickPick.show();
    });
}
function activate(context) {
    return __awaiter(this, void 0, void 0, function* () {
        let lastQuickPick;
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
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.openLineFromVirtualDoc', () => __awaiter(this, void 0, void 0, function* () {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'telescope-results')
                return;
            const line = editor.selection.active.line;
            const text = editor.document.lineAt(line).text;
            const result = lastSearchResults.find(r => text.includes(`Line ${r.line + 1}:`) && text.includes(r.text));
            if (result) {
                const doc = yield vscode.workspace.openTextDocument(result.filePath);
                const shownEditor = yield vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                const pos = new vscode.Position(result.line, 0);
                shownEditor.selection = new vscode.Selection(pos, pos);
                shownEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.openCodelensViewFromPicker', () => __awaiter(this, void 0, void 0, function* () {
            if (lastQuickPick) {
                lastQuickPick.hide();
                yield showCodeLensView(context);
            }
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.startInSubfolder', () => __awaiter(this, void 0, void 0, function* () {
            const currentFolder = yield getCurrentFileFolder();
            if (!currentFolder)
                return;
            workspaceFolder = currentFolder;
            lastSearchFolder = currentFolder;
            yield vscode.commands.executeCommand('telescopeLikeSearch.start');
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.startInSelectedFolder', () => __awaiter(this, void 0, void 0, function* () {
            const selectedFolder = yield selectSearchFolder(context);
            if (!selectedFolder)
                return;
            workspaceFolder = selectedFolder;
            lastSearchFolder = selectedFolder;
            yield vscode.commands.executeCommand('telescopeLikeSearch.start');
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.startInFile', () => __awaiter(this, void 0, void 0, function* () {
            try {
                const selectedFile = yield selectFileToSearch(context);
                if (!selectedFile) {
                    outputChannel.appendLine('[Live Search] No file selected, not launching search-in-file picker.');
                    return;
                }
                outputChannel.appendLine(`[Live Search] About to launch search-in-file picker for: ${selectedFile}`);
                yield launchSearchInFileQuickPick(selectedFile);
            }
            catch (err) {
                outputChannel.appendLine(`[Live Search] Error in startInFile command: ${err}`);
            }
        })));
        // Add test command
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.testFolderSelection', () => __awaiter(this, void 0, void 0, function* () {
            yield testFolderSelection();
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.start', () => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            if (!workspaceFolder) {
                workspaceFolder = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder open.');
                    return;
                }
            }
            const quickPick = vscode.window.createQuickPick();
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
            quickPick.onDidTriggerButton(() => __awaiter(this, void 0, void 0, function* () {
                const selectedFolder = yield selectSearchFolder(context);
                if (selectedFolder) {
                    workspaceFolder = selectedFolder;
                    lastSearchFolder = selectedFolder;
                    quickPick.placeholder = `Search content in ${path.relative(workspaceFolder, selectedFolder)}...`;
                    if (quickPick.value) {
                        runRipgrep(quickPick.value);
                    }
                }
            }));
            let currentProcess = null;
            const runRipgrep = (query) => {
                if (currentProcess)
                    currentProcess.kill();
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
                    workspaceFolder
                ];
                // Add include/exclude patterns
                searchConfig.includePatterns.forEach(pattern => {
                    ripgrepArgs.push('--glob', pattern);
                });
                searchConfig.excludePatterns.forEach(pattern => {
                    ripgrepArgs.push('--glob', `!${pattern}`);
                });
                currentProcess = (0, child_process_1.spawn)('rg', ripgrepArgs, {
                    cwd: workspaceFolder
                });
                if (currentProcess.stdout) {
                    currentProcess.stdout.on('data', (data) => buffer += data.toString());
                }
                currentProcess.on('close', () => {
                    const lines = buffer.split('\n');
                    const results = [];
                    const processedFiles = new Set();
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
                        if (match) {
                            const [, file, lineNum, text] = match;
                            if (processedFiles.has(file))
                                continue;
                            processedFiles.add(file);
                            results.push({
                                label: `${path.relative(workspaceFolder, file)}:${lineNum}`,
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
                        const score = (res) => {
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
                    quickPick.items = results.length > 0
                        ? results
                        : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
                    quickPick.busy = false;
                });
            };
            const debouncedSearch = (0, lodash_debounce_1.default)(runRipgrep, SEARCH_DEBOUNCE_MS);
            quickPick.onDidChangeValue(debouncedSearch);
            quickPick.onDidAccept(() => __awaiter(this, void 0, void 0, function* () {
                const selected = quickPick.selectedItems[0];
                if (selected && selected.line >= 0) {
                    const doc = yield vscode.workspace.openTextDocument(selected.filePath);
                    const editor = yield vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                    const pos = new vscode.Position(selected.line, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
                quickPick.hide();
            }));
            quickPick.onDidHide(() => {
                var _a, _b;
                quickPick.dispose();
                // Reset workspace folder to root after search is done
                workspaceFolder = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.uri.fsPath;
            });
            quickPick.show();
        })));
        context.subscriptions.push(vscode.commands.registerCommand('telescopeLikeSearch.chooseScope', () => __awaiter(this, void 0, void 0, function* () {
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
            const selected = yield vscode.window.showQuickPick(options, {
                placeHolder: 'Choose search scope',
                matchOnDescription: true
            });
            if (selected) {
                yield vscode.commands.executeCommand(selected.command);
            }
        })));
    });
}
function deactivate() { }
class GroupedCodeLensProvider {
    constructor(lensData) {
        this.lensData = lensData;
    }
    provideCodeLenses() {
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
function getGitignorePatterns() {
    try {
        const gitignorePath = path.join(workspaceFolder, '.gitignore');
        const gitignoreContent = vscode.workspace.fs.readFile(vscode.Uri.file(gitignorePath));
        const patterns = gitignoreContent.toString().split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => {
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
    }
    catch (_a) {
        return [];
    }
}
