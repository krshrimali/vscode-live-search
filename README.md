# 🔭 Telescope-Like Search for VSCode

A fast and elegant search UI for Visual Studio Code, inspired by Neovim's Telescope plugin.

- ✅ Fuzzy file content search using ripgrep
- 🧠 Grouped results per file
- 🖱 Clickable line previews with inline context
- 👁 Hover to preview content from matching file
- 📂 Foldable sections for better readability
- 🧑‍💻 Works with VSCodeVim (`j/k`, `:q`, etc.)

---

## Screenshot

![image](https://github.com/user-attachments/assets/5d3f4293-86af-4053-831a-6e947ebc9f79)

---

## 🚀 Features

### 🔍 Live Content Search
- Triggered by `Live Search` command
- Uses `ripgrep` under the hood for blazing-fast results
- Debounced, fuzzy filtering while typing

### 📄 Result View (CodeLens Style)
- Shows matches grouped per file
- Each match includes a few lines of context
- Foldable sections per file using built-in folding support
- Hover over matches to see exact content preview from original file
- Clickable CodeLens to open exact line in editor
- Press `Ctrl+Enter` on a line to open its location

### 🧭 Keyboard Support
- Works seamlessly with VSCodeVim as well.
- `j/k` to move, `:q` to quit, `/` to search in buffer
- `Ctrl+Enter` to open the selected line result

---

## 📦 Installation

1. Clone or download this extension
2. Run `npm install` inside the extension directory
3. Press `F5` to open a new Extension Development Host

---

## 🧰 Commands

| Command                                     | Description                               |
|--------------------------------------------|-------------------------------------------|
| `Live Search`                  | Opens the search QuickPick                |

---

## ⌨️ Keybindings

```json
{
  "key": "ctrl+l",
  "command": "telescopeLikeSearch.openCodelensViewFromPicker",
  "when": "inputFocus && inQuickOpen"
},
{
  "key": "enter",
  "command": "telescopeLikeSearch.openLineFromVirtualDoc",
  "when": "editorTextFocus && resourceScheme == 'telescope-results'"
}
```

> Tip: To ensure VSCodeVim doesn't intercept Enter, add this to settings:
>
```json
"vim.handleKeys": {
  "<Enter>": false
}
```

---

## 🛠 Requirements

- `ripgrep` must be installed and available in your PATH
- VS Code version 1.70+

---

## 📄 License

MIT License © 2025
