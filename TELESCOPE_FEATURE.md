# 🔭 New Telescope-Style File Browser

## Overview

I've successfully implemented a **telescope-style file browser** that provides the two-sidebar layout you requested, similar to Neovim's Telescope plugin. This new feature addresses your specific requirements:

✅ **Two-sidebar layout**
✅ **Line wrapping in preview**
✅ **Left sidebar**: File list
✅ **Right sidebar**: File preview

## How to Use

1. **Command Palette**: Run `Live Search: Telescope File Browser`
2. **Choose Scope Menu**: Run `Live Search: Choose Search Scope` and select "Telescope-style file browser"

## Features

### 🎯 Two-Sidebar Layout
- **Left Sidebar (50% width)**: Shows a list of files with:
  - File name (bold)
  - Directory path (smaller, dimmed)
  - Hover effects for better UX
  - Selection highlighting

- **Right Sidebar (50% width)**: Shows file preview with:
  - **Proper line wrapping** (`white-space: pre-wrap`, `word-wrap: break-word`)
  - Line numbers on the left
  - Syntax-aware styling using VSCode theme colors
  - Scrollable content

### 🔍 Search & Navigation
- **Search bar at top**: Fuzzy search through file names and paths
- **Keyboard navigation**:
  - `↑/↓`: Navigate through files
  - `Enter`: Open selected file
  - `Escape`: Close the telescope view
- **Mouse support**:
  - Click to select file
  - Double-click to open file

### 🎨 Visual Design
- Uses VSCode's native theme colors for consistency
- Proper contrast and accessibility
- Responsive layout that adapts to VSCode themes (light/dark/high-contrast)
- Line numbers styled like VSCode editor

### ⚙️ Configuration
- **Respects your `telescopeLikeSearch.previewLines` setting**
- When you change preview lines from 1 to 10, the telescope view will show 10 lines
- All existing configuration options work with the new view

## Technical Implementation

The solution uses VSCode's **Webview API** to create a custom HTML interface that provides:

1. **Proper line wrapping**: Unlike QuickPick's `detail` field (limited to 100 chars), the webview can display full content with wrapping
2. **Two-column layout**: CSS flexbox layout with 50/50 split
3. **Real-time search**: JavaScript-based filtering without server roundtrips
4. **Theme integration**: Uses VSCode CSS variables for native look and feel

## Why This Approach?

The original implementation used VSCode's QuickPick API, which has limitations:
- `detail` field is truncated at 100 characters
- No support for multi-line content with wrapping
- Single-column layout only

The new webview approach overcomes these limitations while maintaining:
- Native VSCode theming
- Keyboard shortcuts
- File usage tracking (frecency)
- Performance with large file lists

## Testing

To test the feature:
1. Open a workspace with multiple files
2. Set `telescopeLikeSearch.previewLines` to 10 (or your preferred number)
3. Run `Live Search: Telescope File Browser`
4. You should see a two-sidebar interface with proper line wrapping in the preview

The preview will show exactly the number of lines you configured, and long lines will wrap properly within the right sidebar.