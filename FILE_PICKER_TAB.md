# 📁 File Picker Tab

The File Picker Tab is a new feature that provides a dedicated tab interface for browsing and searching files in your workspace, similar to VSCode's built-in Problems tab.

## Features

- **📋 Dedicated Tab Interface**: Opens in a separate tab that stays open, similar to the Problems tab
- **🔍 Fast Search**: Instant file filtering as you type with debounced search
- **👁️ Live File Preview**: Two-pane layout with file list on left and content preview on right
- **🎯 Smart File Icons**: Visual file type indicators with emoji icons for different file types
- **⚡ High Performance**: Uses the pre-built file index for ultra-fast file loading
- **🎨 VSCode-Native Styling**: Matches VSCode's native theme and appearance
- **⌨️ Full Keyboard Navigation**: Navigate with arrow keys, Enter to open, Escape to close
- **📊 File Count Display**: Shows the total number of files and filtered results
- **🔄 Real-time Updates**: Automatically updates when files are added or removed
- **⚙️ Configurable Preview**: Adjustable number of preview lines (1, 3, 5, 10, or 20 lines)
- **📋 Line Numbers**: Preview shows line numbers for better code context

## Usage

### Command Palette
1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type "Live Search: File Picker Tab"
3. Press Enter

### Keyboard Shortcut
- **Windows/Linux**: `Ctrl+Shift+O`
- **macOS**: `Cmd+Shift+O`

### From Choose Search Scope
1. Run `Live Search: Choose Search Scope` command
2. Select "File picker tab" from the menu

## Interface

The File Picker Tab consists of:

### Toolbar
- **Search Input**: Type to filter files instantly
- **Preview Lines Button**: Click to change the number of preview lines (1, 3, 5, 10, or 20)
- **File Count**: Shows current number of visible files

### Two-Pane Layout

#### Left Pane: File List
- **File Icons**: Visual indicators for different file types:
  - 📄 JavaScript/JSX files
  - 🔷 TypeScript/TSX files
  - 📋 JSON files
  - 📝 Markdown files
  - 🌐 HTML files
  - 🎨 CSS/SCSS files
  - 🐍 Python files
  - ☕ Java files
  - 🔧 C/C++/Header files
- **Relative Paths**: Shows full relative paths from workspace root (e.g., `src/components/Button.tsx`)
- **Selection Highlighting**: Currently selected file is highlighted

#### Right Pane: File Preview
- **Preview Header**: Shows the relative path of the selected file
- **Content Preview**: Displays the file content with syntax highlighting
- **Line Numbers**: Shows line numbers for better code navigation
- **Scrollable Content**: Large files can be scrolled within the preview pane

## Keyboard Navigation

- **Search Field**:
  - `Arrow Down`: Move to first file in list and show its preview
  - `Escape`: Close the tab
  
- **File List**:
  - `Arrow Up/Down`: Navigate between files and update preview in real-time
  - `Home/End`: Jump to first/last file and show its preview
  - `Enter` or `Space`: Open selected file in editor
  - `Arrow Up` from first item: Return to search field
  - `Single Click`: Select file and show preview
  - `Double Click`: Open file in editor

## File Type Support

The File Picker Tab recognizes and provides icons for:
- JavaScript (`.js`, `.jsx`)
- TypeScript (`.ts`, `.tsx`)
- JSON (`.json`)
- Markdown (`.md`)
- HTML (`.html`)
- CSS/SCSS (`.css`, `.scss`)
- Python (`.py`)
- Java (`.java`)
- C/C++ (`.c`, `.cpp`, `.h`)

## Performance Features

- **Pre-built Index**: Uses the workspace file index for instant loading
- **Debounced Search**: Optimized search with 150ms debounce for smooth typing
- **Client-side Filtering**: Fast filtering without server round-trips
- **Limited Results**: Shows up to 1000 files for optimal performance
- **Memory Efficient**: Reuses the same file index across all features

## Integration

- **Frecency Support**: Tracks file usage for better sorting in other pickers
- **Theme Integration**: Automatically matches your VSCode theme
- **Workspace Awareness**: Automatically detects workspace changes
- **File Watcher**: Updates automatically when files are added/removed

## Tips

- **Keep it Open**: Unlike quick pickers, this tab stays open for easy file browsing
- **Fast Navigation**: Use keyboard shortcuts for efficient file navigation
- **Search by Path**: Search matches against the full relative path from workspace root
- **Preview While Browsing**: File content updates instantly as you navigate
- **Adjust Preview Lines**: Click the preview lines button to change how much content you see
- **Multiple Tabs**: You can open multiple File Picker Tabs if needed
- **Theme Matching**: The interface automatically adapts to your VSCode theme
- **Quick Open**: Double-click or press Enter to open files without closing the tab
- **Path Context**: Full relative paths help you understand file locations at a glance

## Comparison with Other Pickers

| Feature | File Picker Tab | Quick Pick | Telescope Webview |
|---------|----------------|------------|-------------------|
| Stays Open | ✅ | ❌ | ✅ |
| Search Speed | ⚡ Ultra Fast | ⚡ Ultra Fast | 🔄 Fast |
| Interface | Problems-like | Native Picker | Two-pane |
| Keyboard Nav | ✅ Full | ✅ Full | ✅ Full |
| File Icons | ✅ | ❌ | ❌ |
| Preview | ✅ Live | ✅ Configurable | ✅ Live |
| Line Numbers | ✅ | ❌ | ✅ |
| Preview Lines | ⚙️ Configurable | ⚙️ Configurable | ⚙️ Configurable |

Choose File Picker Tab when you want a persistent, fast file browser that stays open while you work.