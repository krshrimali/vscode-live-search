import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import debounce from 'lodash.debounce';

interface SearchResult extends vscode.QuickPickItem {
  filePath: string;
  line: number;
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('telescopeLikeSearch.start', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const quickPick = vscode.window.createQuickPick<SearchResult>();
    let previewPanel: vscode.WebviewPanel | undefined;

    quickPick.placeholder = 'Search content with ripgrep...';
    quickPick.matchOnDescription = true;

    let currentProcess: ReturnType<typeof spawn> | null = null;

    const updateWebview = (title: string, content: string) => {
      if (!previewPanel) {
        previewPanel = vscode.window.createWebviewPanel(
          'searchPreview',
          'Preview',
          vscode.ViewColumn.Beside,
          { enableScripts: false }
        );
      }

      previewPanel.title = `Preview: ${title}`;
      previewPanel.webview.html = `
        <html>
          <body style="font-family: monospace; white-space: pre; padding: 1em;">
            <h3>${title}</h3>
            <pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
          </body>
        </html>`;
    };

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
        workspaceFolder
      ], { cwd: workspaceFolder });

      if (currentProcess.stdout) {
        currentProcess.stdout.on('data', (data) => {
          buffer += data.toString();
        });
      }

      currentProcess.on('close', () => {
        setTimeout(() => {
          const lines = buffer.split('\n');
          const results: SearchResult[] = [];

          for (const line of lines) {
            if (!line.trim()) continue;
            const match = line.match(/^(.+?):(\d+):\d+:(.*)$/);
            if (match) {
              const [, file, lineNum, text] = match;
              results.push({
                label: `${path.relative(workspaceFolder, file)}:${lineNum}`,
                description: text.trim(),
                detail: file,
                filePath: file,
                line: parseInt(lineNum, 10) - 1
              });
            }
          }

          quickPick.busy = false;
          quickPick.items = results.length > 0
            ? results
            : [{
                label: 'No matches found',
                description: '',
                detail: '',
                filePath: '',
                line: -1
              }];
        }, 0);
      });
    };

    const debouncedSearch = debounce((query: string) => {
      runRipgrep(query);
    }, 150);

    quickPick.onDidChangeValue(debouncedSearch);

    quickPick.onDidChangeSelection((selection: readonly SearchResult[]) => {
      const selected = selection[0];
      if (selected && selected.line >= 0) {
        const uri = vscode.Uri.file(selected.filePath);
        vscode.workspace.openTextDocument(uri).then((doc: vscode.TextDocument) => {
          const start = Math.max(0, selected.line - 5);
          const end = Math.min(doc.lineCount, selected.line + 5);
          const preview = doc.getText(new vscode.Range(start, 0, end, 0));
          updateWebview(path.basename(selected.filePath), preview);
        });
      }
    });

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
      previewPanel?.dispose();
      currentProcess?.kill();
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      previewPanel?.dispose();
      currentProcess?.kill();
    });

    // Optional keyboard support (Tab, Enter, Escape)
    quickPick.onDidTriggerButton((button) => {
      if (button.tooltip === 'Close') {
        quickPick.hide();
      }
    });

    quickPick.show();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}