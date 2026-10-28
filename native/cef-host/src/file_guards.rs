//! Default native UI must not bypass the scoped download adapter. File pickers
//! are explicitly unavailable until selection completion can revalidate the
//! requesting document; CEF's dialog callback does not identify its frame.
use super::*;
pub(super) fn dialogs(id: u64) -> DialogHandler {
    DenyFiles::new(id)
}
pub(super) fn drag(id: u64) -> DragHandler {
    DenyFileDrop::new(id)
}
pub(super) fn menus() -> ContextMenuHandler {
    SafeDefaultMenu::new()
}
wrap_dialog_handler! {
    struct DenyFiles { id: u64 }
    impl DialogHandler {
        fn on_file_dialog(&self, _browser: Option<&mut Browser>, _mode: FileDialogMode,
            _title: Option<&CefString>, _default: Option<&CefString>, _filters: Option<&mut CefStringList>,
            _extensions: Option<&mut CefStringList>, _descriptions: Option<&mut CefStringList>, callback: Option<&mut FileDialogCallback>) -> i32 {
            if let Some(callback) = callback { callback.cancel(); }
            event("policy.file-dialog-denied", self.id, Value::Null); 1
        }
    }
}
wrap_drag_handler! {
    struct DenyFileDrop { id: u64 }
    impl DragHandler {
        fn on_drag_enter(&self, _browser: Option<&mut Browser>, data: Option<&mut DragData>, _mask: DragOperationsMask) -> i32 {
            let denied = data.is_none_or(|data| data.is_file() != 0);
            if denied { event("policy.file-drop-denied", self.id, Value::Null); }
            i32::from(denied)
        }
    }
}
fn allowed(command: i32) -> bool {
    // CEF standard navigation/edit commands. All unknown/custom/native Chromium
    // IDs fail closed, including SaveLink/SaveImage, print and view-source.
    [
        MenuId::BACK,
        MenuId::FORWARD,
        MenuId::RELOAD,
        MenuId::RELOAD_NOCACHE,
        MenuId::STOPLOAD,
        MenuId::UNDO,
        MenuId::REDO,
        MenuId::CUT,
        MenuId::COPY,
        MenuId::PASTE,
        MenuId::PASTE_MATCH_STYLE,
        MenuId::DELETE,
        MenuId::SELECT_ALL,
        MenuId::FIND,
    ]
    .iter()
    .any(|id| i64::from(id.get_raw()) == i64::from(command))
}
wrap_context_menu_handler! {
    struct SafeDefaultMenu;
    impl ContextMenuHandler {
        fn on_before_context_menu(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _params: Option<&mut ContextMenuParams>, model: Option<&mut MenuModel>) {
            if let Some(model) = model {
                for index in (0..model.count()).rev() {
                    if !allowed(model.command_id_at(index)) { model.remove_at(index); }
                }
            }
        }
        fn on_context_menu_command(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _params: Option<&mut ContextMenuParams>, command: i32, _flags: EventFlags) -> i32 { i32::from(!allowed(command)) }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_menu_excludes_file_print_source_and_unknown_commands() {
        // CEF's generated enum backing type differs on Unix and Windows.
        let command = |id: MenuId| i32::try_from(i64::from(id.get_raw())).unwrap();
        assert!(allowed(command(MenuId::COPY)));
        assert!(allowed(command(MenuId::RELOAD)));
        for command in [
            command(MenuId::PRINT),
            command(MenuId::VIEW_SOURCE),
            -1,
            9999,
            26500,
        ] {
            assert!(!allowed(command));
        }
    }
}
