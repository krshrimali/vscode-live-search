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
  const disposable = vscode.commands.registerCommand('telescopeLikeSearch.start', async () => {
    workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const quickPick = vscode.window.createQuickPick<SearchResult>();
    let previewPanel: vscode.WebviewPanel | undefined;

    quickPick.placeholder = 'Search content with ripgrep...';
    quickPick.matchOnDescription = true;
    quickPick.buttons = [
      {
        iconPath: new vscode.ThemeIcon('output'),
        tooltip: 'View search results options'
      }
    ];

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

          quickPick.busy = false;
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
          const start = Math.max(0, selected.line - PREVIEW_LINE_CONTEXT);
          const end = Math.min(doc.lineCount, selected.line + PREVIEW_LINE_CONTEXT);
          const preview = doc.getText(new vscode.Range(start, 0, end, 0));

          const safeContent = preview
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(new RegExp(quickPick.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
              (match) => `<mark>${match}</mark>`);

          if (!previewPanel) {
            previewPanel = vscode.window.createWebviewPanel(
              'searchPreview',
              'Preview',
              vscode.ViewColumn.Beside,
              { enableScripts: false }
            );
          }

          previewPanel.title = `Preview: ${path.basename(selected.filePath)} @${selected.line + 1}`;
          previewPanel.webview.html = `
            <html><body style="font-family: monospace; white-space: pre-wrap; padding: 1em;">
              <pre>${safeContent}</pre>
            </body></html>`;
        });
      }
    });

    quickPick.onDidTriggerButton(async () => {
      const selected = await vscode.window.showQuickPick([
        { label: '📄 Open in Search Editor', value: 'search-editor' },
        { label: '🧾 Export to Markdown View (webview)', value: 'markdown' },
        { label: '📋 Add to Problems Panel', value: 'problems' },
        { label: '❌ Cancel', value: 'cancel' }
      ], { placeHolder: 'Select result view mode' });

      if (!selected || selected.value === 'cancel') return;

      if (selected.value === 'search-editor') {
        const grouped: Record<string, SearchResult[]> = {};
        for (const res of lastSearchResults) {
          if (!grouped[res.filePath]) grouped[res.filePath] = [];
          grouped[res.filePath].push(res);
        }

        let content = '';
        for (const [file, entries] of Object.entries(grouped)) {
          content += `${file}\n`;
          for (const entry of entries) {
            content += `  ${entry.line + 1}: ${entry.text}\n`;
          }
          content += '\n';
        }

        const doc = await vscode.workspace.openTextDocument({
          content: content.trim(),
          language: 'search-result'
        });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }

      if (selected.value === 'markdown') {
        const panel = vscode.window.createWebviewPanel(
          'searchMarkdownResults',
          'Search Markdown Results',
          vscode.ViewColumn.Beside,
          { enableScripts: true, enableCommandUris: true }
        );

        let html = '<html><body style="font-family: monospace; padding: 1em;">';
        for (const res of lastSearchResults) {
          const uri = vscode.Uri.file(res.filePath).with({ fragment: `L${res.line + 1}` });
          const cmdUri = `command:vscode.open?${encodeURIComponent(JSON.stringify([uri]))}`;
          html += `<div><a href="${cmdUri}">${path.relative(workspaceFolder!, res.filePath)}:${res.line + 1}</a>: ${res.text}</div>`;
        }
        html += '</body></html>';

        panel.webview.html = html;
      }

      if (selected.value === 'problems') {
        const diagnostics: vscode.Diagnostic[] = [];
        const diagnosticsMap: Map<string, vscode.Diagnostic[]> = new Map();

        for (const res of lastSearchResults) {
          const range = new vscode.Range(res.line, 0, res.line, res.text.length);
          const diagnostic = new vscode.Diagnostic(range, res.text, vscode.DiagnosticSeverity.Information);
          diagnostic.source = 'TelescopeSearch';
          if (!diagnosticsMap.has(res.filePath)) {
            diagnosticsMap.set(res.filePath, []);
          }
          diagnosticsMap.get(res.filePath)?.push(diagnostic);
        }

        for (const [file, fileDiagnostics] of diagnosticsMap.entries()) {
          const uri = vscode.Uri.file(file);
          vscode.languages.createDiagnosticCollection('TelescopeSearch').set(uri, fileDiagnostics);
        }
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

    quickPick.show();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
