# 🚨 Problems Picker

The Problems Picker is a new feature that allows you to browse and navigate to all workspace problems/diagnostics with a live preview and immediate search functionality.

## Features

- **📋 All Problems in One View**: Shows all errors, warnings, info messages, and hints from your workspace
- **🔍 Instant Search**: Focus automatically goes to the search field so you can start filtering immediately
- **🎨 Visual Severity Indicators**: 
  - ❌ Errors (red)
  - ⚠️ Warnings (yellow) 
  - ℹ️ Information (blue)
  - 💡 Hints (light bulb)
- **📖 Multi-line Preview**: Shows the problematic code with configurable context lines
- **🎯 Smart Sorting**: Problems are sorted by severity (errors first), then by file path and line number
- **⚡ Quick Navigation**: Click or press Enter to jump directly to the problem location

## Usage

### Command Palette
1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type "Live Search: Problems Picker"
3. Press Enter

### Keyboard Shortcut
- **Windows/Linux**: `Ctrl+Shift+M`
- **macOS**: `Cmd+Shift+M`

### From Choose Search Scope
1. Run `Live Search: Choose Search Scope` command
2. Select "Problems picker" from the menu

## Configuration

The Problems Picker uses the existing `telescopeLikeSearch.previewLines` setting to control how many lines of context to show around each problem:

```json
{
  "telescopeLikeSearch.previewLines": 3  // Shows 3 lines of context (default: 1)
}
```

## Example Preview

When you run the Problems Picker, you'll see something like:

```
❌ Cannot find name 'undeclaredVariable'
src/example.ts:4:13
→    4: console.log(undeclaredVariable);
     5: 
     6: // Error: Type mismatch

⚠️ 'unusedVariable' is declared but its value is never read
src/example.ts:8:5
     7: // Warning: Unused variable
→    8: let unusedVariable = "I am not used anywhere";
     9: 
    10: // Error: Function with no return type
```

## Tips

- **Type to search**: The search field is automatically focused, so you can immediately start typing to filter problems
- **Search everything**: You can search by error message, file path, or even the code content in the preview
- **Navigate quickly**: Use arrow keys to navigate, Enter to open, Escape to close
- **Context matters**: Increase `previewLines` to see more context around each problem

## Integration with VSCode

The Problems Picker integrates seamlessly with VSCode's diagnostic system:
- Works with all language servers (TypeScript, ESLint, etc.)
- Respects your existing problem filters and settings
- Updates automatically when problems change
- Maintains the same problem locations as the built-in Problems panel