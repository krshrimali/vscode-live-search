# 🔭 Telescope-Like Search for VSCode

Please note that, while the ideas are mine, all of the implementation was done by Cursor Agent. I don't intend to learn how to build VSCode Extensions, I just intend to build things I would use. This is purely a "Vibe Coding" project.

A fast and elegant search UI for Visual Studio Code, inspired by Neovim's Telescope plugin.

- ✅ Fuzzy file content search using ripgrep
- 🧠 Grouped results per file
- 🖱 Clickable line previews with inline context
- 👁 Hover to preview content from matching file
- 📂 Foldable sections for better readability
- 🧑‍💻 Works with VSCodeVim (`j/k`, `:q`, etc.)
- 📁 File picker with content preview (like Ctrl+P but with file content preview)

Please make sure to have `ripgrep` installed on your system.

---

## Screenshot

![image](https://github.com/user-attachments/assets/5d3f4293-86af-4053-831a-6e947ebc9f79)

---

## 🚀 Features

### 🔍 Live Content Search
- Triggered by `Live Search` command
- Uses `ripgrep` under the hood for blazing-fast results
- Debounced, fuzzy filtering while typing

### 📁 File Picker with Preview
- Similar to VSCode's Ctrl+P but shows file content preview
- Configurable number of preview lines (1, 3, 5, 10, or 20 lines)
- Interactive button to change preview lines on-the-fly
- Fuzzy file name and path matching
- Frecency-based file ranking (most frequently and recently used files first)

### 🔭 Telescope-Style File Browser
- **Two-sidebar layout** like Neovim's Telescope
- **Left sidebar**: List of files with fuzzy search
- **Right sidebar**: File preview with **proper line wrapping**
- **Keyboard navigation**: Arrow keys, Enter to open, Escape to close
- **Mouse support**: Click to select, double-click to open
- **Respects preview lines setting** from configuration

### 🚨 Problems Picker
- **Browse all workspace problems/diagnostics** with multi-line preview
- **Automatic focus** on search field for immediate filtering
- **Severity icons**: ❌ Errors, ⚠️ Warnings, ℹ️ Info, 💡 Hints
- **Smart sorting**: Errors first, then warnings, then by file and line
- **Multi-line context preview** around each problem

### 📁 File Picker Tab (NEW!)
- **Dedicated tab interface** similar to VSCode's Problems tab
- **Ultra-fast file search** with instant filtering by relative path
- **Live file preview** with two-pane layout and line numbers
- **Smart file type icons** for visual file identification
- **Full relative paths** displayed from workspace root for better context
- **Persistent tab** that stays open while you work
- **Full keyboard navigation** with arrow keys and shortcuts
- **Configurable preview lines** with interactive button to change settings
- **Real-time file count** display and updates

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
| `Live Search: File Picker with Preview`    | Opens file picker with content preview   |
| `Live Search: Telescope File Browser`      | Opens telescope-style two-sidebar file browser |
| `Live Search: Problems Picker`             | Opens problems/diagnostics picker with preview |
| `Live Search: Choose Search Scope`         | Shows menu to choose between different search modes |

---

## ⌨️ Default Keybindings

```json
{
  "key": "ctrl+p",
  "command": "telescopeLikeSearch.filePicker",
  "when": "!inQuickOpen"
},
{
  "key": "ctrl+shift+m",
  "command": "telescopeLikeSearch.problemsPicker",
  "when": "!inQuickOpen"
},
{
  "key": "ctrl+shift+o",
  "command": "telescopeLikeSearch.filePickerTab",
  "when": "!inQuickOpen"
},
{
  "key": "ctrl+l",
  "command": "telescopeLikeSearch.openCodelensViewFromPicker",
  "when": "inputFocus && inQuickOpen"
},
{
  "key": "ctrl+enter",
  "command": "telescopeLikeSearch.openLineFromVirtualDoc",
  "when": "editorTextFocus && resourceScheme == 'telescope-results'"
}
```

---

## ⚙️ Configuration

The extension provides several configuration options:

```json
{
  // Number of lines to show in file preview (default: 1)
  "telescopeLikeSearch.previewLines": 1,
  
  // Maximum number of items to show in pickers (default: 30)
  "telescopeLikeSearch.maxItemsInPicker": 30,
  
  // Glob patterns for files to exclude from search
  "telescopeLikeSearch.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/.git/**"
  ],
  
  // Maximum file size in bytes to include in search (default: 1MB)
  "telescopeLikeSearch.maxFileSize": 1048576
}
```

---

## 🛠 Requirements

- `ripgrep` must be installed and available in your PATH
- VS Code version 1.70+

---

## 📄 License

MIT License © 2025
