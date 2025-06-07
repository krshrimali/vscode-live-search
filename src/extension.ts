import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import debounce from 'lodash.debounce';

interface SearchResult extends vscode.QuickPickItem {
  filePath: string;
  line: number;
  text: string;
}

let lastSearchResults: SearchResult[] = [];
let workspaceFolder: string | undefined;
const PREVIEW_LINE_CONTEXT = 2;

export function activate(context: vscode.ExtensionContext) {
  let lastQuickPick: vscode.QuickPick<SearchResult> | undefined;

  const showCodeLensView = async () => {
    const grouped: Record<string, SearchResult[]> = {};
    for (const res of lastSearchResults) {
      if (!grouped[res.filePath]) grouped[res.filePath] = [];
      grouped[res.filePath].push(res);
    }

    const lines: string[] = [];
    const lensMap: { line: number, result: SearchResult }[] = [];

    for (const [file, results] of Object.entries(grouped)) {
      lines.push(`📁 ${file}`);
      for (const res of results) {
        const lineNum = lines.length;
        lensMap.push({ line: lineNum, result: res });
        lines.push(`   → Line ${res.line + 1}: ${res.text}`);

        try {
          const doc = await vscode.workspace.openTextDocument(res.filePath);
          const start = Math.max(0, res.line - 1);
          const end = Math.min(doc.lineCount, res.line + 2);
          const contextLines = doc.getText(new vscode.Range(start, 0, end, 0)).split('\n');
          for (const ctxLine of contextLines) {
            lines.push(`      ${ctxLine}`);
          }
          lines.push('');
        } catch {
          lines.push('      [Unable to preview context]');
          lines.push('');
        }
      }
      lines.push('');
    }

    const content = lines.join('\n');
    const fakeFilePath = path.join(workspaceFolder!, '.telescope-results.md');
    const fakeFileUri = vscode.Uri.file(fakeFilePath).with({ scheme: 'untitled' });

    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

    const codeLensProvider = new GroupedCodeLensProvider(lensMap);
    const hoverProvider = vscode.languages.registerHoverProvider(
      { pattern: '**/.telescope-results.md' },
      {
        provideHover(document, position) {
          const result = lensMap.find(r => r.line === position.line)?.result;
          if (!result) return;
          return new vscode.Hover(
            `🔎 Open [${path.basename(result.filePath)}:${result.line + 1}](${vscode.Uri.file(result.filePath)})`
          );
        }
      }
    );

    const openCommand = vscode.commands.registerCommand('telescopeLikeSearch.openLineFromVirtualDoc', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const line = editor.selection.active.line;
      const result = lensMap.find(r => r.line === line)?.result;
      if (!result) return;

      const doc = await vscode.workspace.openTextDocument(result.filePath);
      const editorToShow = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const pos = new vscode.Position(result.line, 0);
      editorToShow.selection = new vscode.Selection(pos, pos);
      editorToShow.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    });

    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ pattern: '**/.telescope-results.md' }, codeLensProvider),
      hoverProvider,
      openCommand
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('telescopeLikeSearch.openCodelensViewFromPicker', async () => {
      if (lastQuickPick) {
        lastQuickPick.hide();
        await showCodeLensView();
      }
    })
  );

  const disposable = vscode.commands.registerCommand('telescopeLikeSearch.start', async () => {
    workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const quickPick = vscode.window.createQuickPick<SearchResult>();
    lastQuickPick = quickPick;

    quickPick.placeholder = 'Search content with ripgrep...';
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

      currentProcess = spawn('rg', [
        '--vimgrep',
        '--smart-case',
        '--hidden',
        '--no-heading',
        '--color', 'never',
        '--max-count', '300',
        '--text',
        query,
        workspaceFolder!
      ], { cwd: workspaceFolder });

      currentProcess.stdout?.on('data', (data) => buffer += data.toString());

      currentProcess.on('close', () => {
        const lines = buffer.split('\n');
        const results: SearchResult[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
          if (match) {
            const [, file, lineNum, text] = match;
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

        lastSearchResults = results;

        quickPick.items = results.length > 0
          ? results
          : [{
            label: 'No matches found',
            description: '',
            detail: '',
            filePath: '',
            line: -1,
            text: ''
          }];
        quickPick.busy = false;
      });
    };

    const debouncedSearch = debounce(runRipgrep, 150);
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

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

class GroupedCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private lensData: { line: number, result: SearchResult }[]) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
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
