// Entry point of the vendored editor bundle (see build.sh). Only what app/static/js/rich-editor.js uses.
export { EditorState, EditorSelection, Compartment, Annotation } from '@codemirror/state';
export { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
export { history, historyKeymap, defaultKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
