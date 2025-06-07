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
    vscode.commands.registerCommand('telescopeLikeSearch.start', async () => {
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

            return score(b) - score(a);  // descending!
          });

          lastSearchResults = results;

          quickPick.items = results.length > 0
            ? results
            : [{ label: 'No matches found', description: '', detail: '', filePath: '', line: -1, text: '' }];
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
    })
  );
}

async function showCodeLensView(context: vscode.ExtensionContext) {
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
        lines.push('      [Unable to preview context]', '');
      }
    }
    lines.push('');
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
