use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::{null, null_mut};

use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, GetLastError, HWND, LPARAM,
    LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
use windows_sys::Win32::Graphics::Gdi::{
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, COLOR_WINDOW, CreateFontW, DEFAULT_CHARSET,
    DEFAULT_PITCH, DeleteObject, FF_DONTCARE, FW_REGULAR, FW_SEMIBOLD, GetSysColor,
    GetSysColorBrush, HFONT, OUT_DEFAULT_PRECIS, SetBkColor,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, REG_SZ, RRF_NOEXPAND, RRF_RT_ANY, RegDeleteKeyValueW, RegGetValueW,
    RegSetKeyValueW,
};
use windows_sys::Win32::UI::Controls::{BST_CHECKED, BST_UNCHECKED, EM_SETSEL};
use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_SETVERSION, NIN_SELECT,
    NOTIFYICON_VERSION_4, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BN_CLICKED, BS_AUTOCHECKBOX, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT,
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, ES_AUTOHSCROLL, ES_READONLY,
    FindWindowW, GWLP_USERDATA, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, HICON, IDC_ARROW,
    IMAGE_ICON, IsDialogMessageW, IsWindow, KillTimer, LR_SHARED, LoadCursorW, LoadImageW,
    MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MSG, MessageBoxW, MoveWindow, PostMessageW,
    PostQuitMessage, RegisterClassExW, RegisterWindowMessageW, SIZE_MINIMIZED, SM_CXICON,
    SM_CXSMICON, SM_CYICON, SM_CYSMICON, SW_HIDE, SW_RESTORE, SW_SHOW, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOZORDER, SendMessageW, SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_COPY, WM_CREATE,
    WM_CTLCOLORBTN, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DPICHANGED, WM_ENDSESSION, WM_LBUTTONUP,
    WM_NCCREATE, WM_NCDESTROY, WM_QUERYENDSESSION, WM_SETFONT, WM_SIZE, WM_TIMER, WNDCLASSEXW,
    WS_CAPTION, WS_CHILD, WS_EX_CLIENTEDGE, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP,
    WS_VISIBLE,
};

const WINDOW_CLASS: &str = "MyDevToolsLocalAgentWindow";
const WINDOW_TITLE: &str = "MyDevTools Local Agent";
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "MyDevToolsLocalAgent";

const TRAY_ICON_ID: u32 = 1;
const TIMER_ID: usize = 1;
const WM_TRAY: u32 = WM_APP + 1;
const WM_SHOW_EXISTING: u32 = WM_APP + 2;
const NIN_KEYSELECT_EVENT: u32 = NIN_SELECT + 1;

const ID_AUTOSTART: usize = 1001;
const ID_COPY: usize = 1002;
const ID_EXIT: usize = 1003;
const ICON_RESOURCE_ID: usize = 1;
const BASE_DPI: u32 = 96;
const CLIENT_WIDTH: i32 = 456;
const CLIENT_HEIGHT: i32 = 258;

struct UiStrings {
    heading: &'static str,
    version: &'static str,
    pairing_code: &'static str,
    copy: &'static str,
    autostart: &'static str,
    location_note: &'static str,
    exit: &'static str,
    autostart_error: &'static str,
    autostart_read_error: &'static str,
    pairing_error: &'static str,
    executable_error: &'static str,
    command_too_long: &'static str,
}

static ENGLISH: UiStrings = UiStrings {
    heading: "The local agent is running",
    version: "Version",
    pairing_code: "Pairing code",
    copy: "Copy",
    autostart: "Start automatically when I sign in",
    location_note: "Keep this executable in its current location for autostart to work.",
    exit: "Exit",
    autostart_error: "Unable to update autostart",
    autostart_read_error: "Unable to read autostart settings",
    pairing_error: "Unable to read the pairing code.",
    executable_error: "Unable to locate this executable",
    command_too_long: "The executable path is too long for autostart.",
};

static RUSSIAN: UiStrings = UiStrings {
    heading: "Локальный агент запущен",
    version: "Версия",
    pairing_code: "Код подключения",
    copy: "Копировать",
    autostart: "Запускать автоматически при входе в систему",
    location_note: "Не перемещайте этот файл, иначе автозапуск перестанет работать.",
    exit: "Выход",
    autostart_error: "Не удалось изменить автозапуск",
    autostart_read_error: "Не удалось прочитать настройку автозапуска",
    pairing_error: "Не удалось получить код подключения.",
    executable_error: "Не удалось определить путь к исполняемому файлу",
    command_too_long: "Путь к исполняемому файлу слишком длинный для автозапуска.",
};
#[derive(Clone, Copy)]
struct Controls {
    heading: HWND,
    version: HWND,
    pairing_label: HWND,
    pairing_edit: HWND,
    copy_button: HWND,
    autostart_checkbox: HWND,
    note: HWND,
    exit_button: HWND,
}

struct WindowState {
    get_pairing_code: Box<dyn Fn() -> String + Send>,
    shutdown: CancellationToken,
    strings: &'static UiStrings,
    controls: Cell<Option<Controls>>,
    normal_font: Cell<HFONT>,
    heading_font: Cell<HFONT>,
    tray_icon: HICON,
    tray_added: Cell<bool>,
    taskbar_created: u32,
    last_pairing_code: RefCell<String>,
    startup_error: RefCell<Option<String>>,
    window_ready: Cell<bool>,
}

pub(crate) fn run(
    get_pairing_code: Box<dyn Fn() -> String + Send>,
    shutdown: CancellationToken,
    start_hidden: bool,
) -> Result<(), String> {
    // SAFETY: this thread exclusively owns the window class, window, and message loop below.
    unsafe {
        let class_name = wide(WINDOW_CLASS);
        let title = wide(WINDOW_TITLE);
        let taskbar_message_name = wide("TaskbarCreated");
        let instance = GetModuleHandleW(null());
        if instance.is_null() {
            return Err(last_error("GetModuleHandleW failed"));
        }

        let large_icon = load_app_icon(
            instance,
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON),
        )?;
        let small_icon = load_app_icon(
            instance,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
        )?;
        let cursor = LoadCursorW(null_mut(), IDC_ARROW);
        if cursor.is_null() {
            return Err(last_error("LoadCursorW failed"));
        }

        let window_class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: large_icon,
            hCursor: cursor,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: small_icon,
        };
        if RegisterClassExW(&window_class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(last_error("RegisterClassExW failed"));
        }

        let taskbar_created = RegisterWindowMessageW(taskbar_message_name.as_ptr());
        if taskbar_created == 0 {
            return Err(last_error("RegisterWindowMessageW failed"));
        }

        let state = Box::new(WindowState {
            get_pairing_code,
            shutdown,
            strings: ui_strings(),
            controls: Cell::new(None),
            normal_font: Cell::new(null_mut()),
            heading_font: Cell::new(null_mut()),
            tray_icon: small_icon,
            tray_added: Cell::new(false),
            taskbar_created,
            last_pairing_code: RefCell::new(String::new()),
            startup_error: RefCell::new(None),
            window_ready: Cell::new(false),
        });
        let state_pointer = (&*state as *const WindowState).cast::<c_void>();
        let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        let window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            300,
            null_mut(),
            null_mut(),
            instance,
            state_pointer,
        );
        if window.is_null() {
            return Err(state
                .startup_error
                .borrow_mut()
                .take()
                .unwrap_or_else(|| last_error("CreateWindowExW failed")));
        }

        // Keep ownership through the entire message loop, including reentrant Win32 calls.
        state.window_ready.set(true);

        if !start_hidden {
            ShowWindow(window, SW_SHOW);
            SetForegroundWindow(window);
        }

        let mut message: MSG = zeroed();
        let loop_result = loop {
            let result = GetMessageW(&mut message, null_mut(), 0, 0);
            if result == -1 {
                break Err(last_error("GetMessageW failed"));
            }
            if result == 0 {
                break Ok(());
            }
            if IsDialogMessageW(window, &message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        };

        if IsWindow(window) != 0 {
            DestroyWindow(window);
        }
        loop_result
    }
}

pub(crate) fn show_existing() -> bool {
    let class_name = wide(WINDOW_CLASS);
    // SAFETY: class_name is NUL-terminated and remains alive for both calls.
    unsafe {
        let window = FindWindowW(class_name.as_ptr(), null());
        if window.is_null() {
            return false;
        }
        PostMessageW(window, WM_SHOW_EXISTING, 0, 0) != 0
    }
}

pub(crate) fn show_error(message: &str) {
    let message = wide(&message.replace('\0', " "));
    let title = wide(WINDOW_TITLE);
    // SAFETY: both strings are NUL-terminated and remain alive through this synchronous call.
    unsafe {
        MessageBoxW(
            null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match catch_unwind(AssertUnwindSafe(|| unsafe {
        window_proc_inner(window, message, wparam, lparam)
    })) {
        Ok(result) => result,
        Err(_) => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

unsafe fn window_proc_inner(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        if create.is_null() || unsafe { (*create).lpCreateParams.is_null() } {
            return 0;
        }
        unsafe {
            SetWindowLongPtrW(window, GWLP_USERDATA, (*create).lpCreateParams as isize);
            return DefWindowProcW(window, message, wparam, lparam);
        }
    }

    let state_pointer = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) as *mut WindowState };
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }

    if message == WM_NCDESTROY {
        let state = unsafe { &*state_pointer };
        unsafe {
            state.release_fonts();
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            return DefWindowProcW(window, message, wparam, lparam);
        }
    }

    // Win32 may synchronously reenter this callback: never hold an exclusive state borrow.
    let state = unsafe { &*state_pointer };
    if message == state.taskbar_created {
        state.tray_added.set(false);
        let _ = unsafe { state.add_tray_icon(window) };
        return 0;
    }

    match message {
        WM_CREATE => match unsafe { state.initialize(window) } {
            Ok(()) => 0,
            Err(error) => {
                *state.startup_error.borrow_mut() = Some(error);
                -1
            }
        },
        WM_SHOW_EXISTING => {
            unsafe { show_and_activate(window) };
            0
        }
        WM_TRAY => {
            let event = (lparam as u32) & 0xffff;
            if event == WM_LBUTTONUP || event == NIN_SELECT || event == NIN_KEYSELECT_EVENT {
                unsafe { show_and_activate(window) };
            }
            0
        }
        WM_COMMAND => {
            let control_id = wparam & 0xffff;
            let notification = (wparam >> 16) as u32;
            if notification == BN_CLICKED {
                match control_id {
                    ID_AUTOSTART => unsafe { state.change_autostart(window) },
                    ID_COPY => unsafe {
                        if let Some(controls) = state.controls.get() {
                            SendMessageW(controls.pairing_edit, EM_SETSEL, 0, -1);
                            SendMessageW(controls.pairing_edit, WM_COPY, 0, 0);
                        }
                    },
                    ID_EXIT => unsafe {
                        state.shutdown.cancel();
                        DestroyWindow(window);
                    },
                    _ => {}
                }
            }
            0
        }
        WM_TIMER if wparam == TIMER_ID => {
            if state.shutdown.is_cancelled() {
                unsafe { DestroyWindow(window) };
                return 0;
            }
            state.refresh_pairing_code();
            if !state.tray_added.get() {
                let _ = unsafe { state.add_tray_icon(window) };
            }
            0
        }
        WM_DPICHANGED => {
            let suggested = lparam as *const RECT;
            if !suggested.is_null() {
                let suggested = unsafe { &*suggested };
                unsafe {
                    SetWindowPos(
                        window,
                        null_mut(),
                        suggested.left,
                        suggested.top,
                        suggested.right - suggested.left,
                        suggested.bottom - suggested.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
            let dpi = ((wparam >> 16) as u32).max(BASE_DPI);
            let _ = unsafe { state.apply_layout(window, dpi, false) };
            0
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => {
            unsafe { SetBkColor(wparam as _, GetSysColor(COLOR_WINDOW)) };
            unsafe { GetSysColorBrush(COLOR_WINDOW) as LRESULT }
        }
        WM_SIZE if wparam as u32 == SIZE_MINIMIZED => {
            unsafe { ShowWindow(window, SW_HIDE) };
            0
        }
        WM_CLOSE => {
            unsafe { ShowWindow(window, SW_HIDE) };
            0
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wparam != 0 {
                state.shutdown.cancel();
                unsafe { DestroyWindow(window) };
            }
            0
        }
        WM_DESTROY => {
            unsafe {
                KillTimer(window, TIMER_ID);
                state.remove_tray_icon(window);
                if state.window_ready.get() {
                    PostQuitMessage(0);
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

impl WindowState {
    unsafe fn initialize(&self, window: HWND) -> Result<(), String> {
        let instance = unsafe { GetModuleHandleW(null()) };
        if instance.is_null() {
            return Err(last_error("GetModuleHandleW failed"));
        }

        let version = format!("{}: {}", self.strings.version, env!("CARGO_PKG_VERSION"));
        let controls = Controls {
            heading: unsafe {
                create_control(
                    window,
                    instance,
                    "STATIC",
                    self.strings.heading,
                    WS_CHILD | WS_VISIBLE,
                    0,
                    20,
                    16,
                    416,
                    24,
                    0,
                )?
            },
            version: unsafe {
                create_control(
                    window,
                    instance,
                    "STATIC",
                    &version,
                    WS_CHILD | WS_VISIBLE,
                    0,
                    20,
                    46,
                    416,
                    20,
                    0,
                )?
            },
            pairing_label: unsafe {
                create_control(
                    window,
                    instance,
                    "STATIC",
                    self.strings.pairing_code,
                    WS_CHILD | WS_VISIBLE,
                    0,
                    20,
                    77,
                    416,
                    20,
                    0,
                )?
            },
            pairing_edit: unsafe {
                create_control(
                    window,
                    instance,
                    "EDIT",
                    "",
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL as u32 | ES_READONLY as u32,
                    WS_EX_CLIENTEDGE,
                    20,
                    99,
                    306,
                    30,
                    0,
                )?
            },
            copy_button: unsafe {
                create_control(
                    window,
                    instance,
                    "BUTTON",
                    self.strings.copy,
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                    0,
                    334,
                    98,
                    102,
                    32,
                    ID_COPY,
                )?
            },
            autostart_checkbox: unsafe {
                create_control(
                    window,
                    instance,
                    "BUTTON",
                    self.strings.autostart,
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX as u32,
                    0,
                    20,
                    145,
                    416,
                    24,
                    ID_AUTOSTART,
                )?
            },
            note: unsafe {
                create_control(
                    window,
                    instance,
                    "STATIC",
                    self.strings.location_note,
                    WS_CHILD | WS_VISIBLE,
                    0,
                    40,
                    172,
                    396,
                    34,
                    0,
                )?
            },
            exit_button: unsafe {
                create_control(
                    window,
                    instance,
                    "BUTTON",
                    self.strings.exit,
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                    0,
                    334,
                    216,
                    102,
                    31,
                    ID_EXIT,
                )?
            },
        };
        self.controls.set(Some(controls));

        let dpi = unsafe { GetDpiForWindow(window) }.max(BASE_DPI);
        unsafe { self.apply_layout(window, dpi, true)? };

        self.refresh_pairing_code();
        if self.last_pairing_code.borrow().is_empty() {
            return Err(self.strings.pairing_error.to_owned());
        }

        match autostart_enabled() {
            Ok(enabled) => unsafe {
                SendMessageW(
                    controls.autostart_checkbox,
                    windows_sys::Win32::UI::WindowsAndMessaging::BM_SETCHECK,
                    (if enabled { BST_CHECKED } else { BST_UNCHECKED }) as usize,
                    0,
                );
            },
            Err(error) => show_owned_error(
                window,
                &format!("{}: {error}", self.strings.autostart_read_error),
            ),
        }

        unsafe { self.add_tray_icon(window)? };
        if unsafe { SetTimer(window, TIMER_ID, 1_000, None) } == 0 {
            unsafe { self.remove_tray_icon(window) };
            return Err(last_error("SetTimer failed"));
        }
        Ok(())
    }

    unsafe fn apply_layout(
        &self,
        window: HWND,
        dpi: u32,
        resize_window: bool,
    ) -> Result<(), String> {
        let Some(controls) = self.controls.get() else {
            return Ok(());
        };

        if resize_window {
            let mut bounds = RECT {
                left: 0,
                top: 0,
                right: scale_for_dpi(CLIENT_WIDTH, dpi),
                bottom: scale_for_dpi(CLIENT_HEIGHT, dpi),
            };
            let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
            if unsafe { AdjustWindowRectExForDpi(&mut bounds, style, 0, 0, dpi) } == 0 {
                return Err(last_error("AdjustWindowRectExForDpi failed"));
            }
            if unsafe {
                SetWindowPos(
                    window,
                    null_mut(),
                    0,
                    0,
                    bounds.right - bounds.left,
                    bounds.bottom - bounds.top,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
            } == 0
            {
                return Err(last_error("SetWindowPos failed"));
            }
        }

        for (control, x, y, width, height) in [
            (controls.heading, 20, 16, 416, 24),
            (controls.version, 20, 46, 416, 20),
            (controls.pairing_label, 20, 77, 416, 20),
            (controls.pairing_edit, 20, 99, 306, 30),
            (controls.copy_button, 334, 98, 102, 32),
            (controls.autostart_checkbox, 20, 145, 416, 24),
            (controls.note, 40, 172, 396, 34),
            (controls.exit_button, 334, 216, 102, 31),
        ] {
            if unsafe {
                MoveWindow(
                    control,
                    scale_for_dpi(x, dpi),
                    scale_for_dpi(y, dpi),
                    scale_for_dpi(width, dpi),
                    scale_for_dpi(height, dpi),
                    1,
                )
            } == 0
            {
                return Err(last_error("MoveWindow failed"));
            }
        }

        unsafe { self.install_fonts(controls, dpi) }
    }

    unsafe fn install_fonts(&self, controls: Controls, dpi: u32) -> Result<(), String> {
        let face_name = wide("Segoe UI");
        let normal_font = unsafe {
            CreateFontW(
                -scale_for_dpi(12, dpi),
                0,
                0,
                0,
                FW_REGULAR as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                (DEFAULT_PITCH | FF_DONTCARE) as u32,
                face_name.as_ptr(),
            )
        };
        if normal_font.is_null() {
            return Err(last_error("CreateFontW failed"));
        }
        let heading_font = unsafe {
            CreateFontW(
                -scale_for_dpi(15, dpi),
                0,
                0,
                0,
                FW_SEMIBOLD as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                (DEFAULT_PITCH | FF_DONTCARE) as u32,
                face_name.as_ptr(),
            )
        };
        if heading_font.is_null() {
            unsafe { DeleteObject(normal_font) };
            return Err(last_error("CreateFontW failed"));
        }

        unsafe { SendMessageW(controls.heading, WM_SETFONT, heading_font as usize, 1) };
        for control in [
            controls.version,
            controls.pairing_label,
            controls.pairing_edit,
            controls.copy_button,
            controls.autostart_checkbox,
            controls.note,
            controls.exit_button,
        ] {
            unsafe { SendMessageW(control, WM_SETFONT, normal_font as usize, 1) };
        }

        let old_normal = self.normal_font.replace(normal_font);
        let old_heading = self.heading_font.replace(heading_font);
        if !old_normal.is_null() {
            unsafe { DeleteObject(old_normal) };
        }
        if !old_heading.is_null() {
            unsafe { DeleteObject(old_heading) };
        }
        Ok(())
    }

    unsafe fn release_fonts(&self) {
        for font in [
            self.normal_font.replace(null_mut()),
            self.heading_font.replace(null_mut()),
        ] {
            if !font.is_null() {
                unsafe { DeleteObject(font) };
            }
        }
    }

    fn refresh_pairing_code(&self) {
        let code = catch_unwind(AssertUnwindSafe(|| (self.get_pairing_code)()));
        let Ok(code) = code else {
            return;
        };
        if code == *self.last_pairing_code.borrow() {
            return;
        }
        let code = code.replace('\0', " ");
        let text = wide(&code);
        let Some(controls) = self.controls.get() else {
            return;
        };
        *self.last_pairing_code.borrow_mut() = code;
        // No RefCell borrow may span this reentrant call.
        unsafe { SetWindowTextW(controls.pairing_edit, text.as_ptr()) };
    }

    unsafe fn change_autostart(&self, window: HWND) {
        let Some(controls) = self.controls.get() else {
            return;
        };
        let checked = unsafe {
            SendMessageW(
                controls.autostart_checkbox,
                windows_sys::Win32::UI::WindowsAndMessaging::BM_GETCHECK,
                0,
                0,
            ) as u32
                == BST_CHECKED
        };
        if let Err(error) = set_autostart(checked) {
            unsafe {
                SendMessageW(
                    controls.autostart_checkbox,
                    windows_sys::Win32::UI::WindowsAndMessaging::BM_SETCHECK,
                    (if checked { BST_UNCHECKED } else { BST_CHECKED }) as usize,
                    0,
                );
            }
            show_owned_error(
                window,
                &format!("{}: {error}", self.strings.autostart_error),
            );
        }
    }

    unsafe fn add_tray_icon(&self, window: HWND) -> Result<(), String> {
        if self.tray_added.get() {
            return Ok(());
        }
        let mut data = tray_icon_data(window);
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = WM_TRAY;
        data.hIcon = self.tray_icon;
        copy_wide_into(&mut data.szTip, WINDOW_TITLE);
        if unsafe { Shell_NotifyIconW(NIM_ADD, &data) } == 0 {
            self.tray_added.set(false);
            return Err(last_error("Shell_NotifyIconW(NIM_ADD) failed"));
        }

        data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
        if unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) } == 0 {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
            self.tray_added.set(false);
            return Err(last_error("Shell_NotifyIconW(NIM_SETVERSION) failed"));
        }
        self.tray_added.set(true);
        Ok(())
    }

    unsafe fn remove_tray_icon(&self, window: HWND) {
        if self.tray_added.get() {
            let data = tray_icon_data(window);
            unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
            self.tray_added.set(false);
        }
    }
}

fn scale_for_dpi(value: i32, dpi: u32) -> i32 {
    ((i64::from(value) * i64::from(dpi) + i64::from(BASE_DPI / 2)) / i64::from(BASE_DPI)) as i32
}

unsafe fn load_app_icon(instance: *mut c_void, width: i32, height: i32) -> Result<HICON, String> {
    let icon = unsafe {
        LoadImageW(
            instance,
            ICON_RESOURCE_ID as *const u16,
            IMAGE_ICON,
            width,
            height,
            LR_SHARED,
        )
    } as HICON;
    if icon.is_null() {
        Err(last_error("LoadImageW icon failed"))
    } else {
        Ok(icon)
    }
}

unsafe fn create_control(
    parent: HWND,
    instance: *mut c_void,
    class_name: &str,
    text: &str,
    style: u32,
    extended_style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    id: usize,
) -> Result<HWND, String> {
    let class_name = wide(class_name);
    let text = wide(text);
    let control = unsafe {
        CreateWindowExW(
            extended_style,
            class_name.as_ptr(),
            text.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent,
            id as *mut c_void,
            instance,
            null(),
        )
    };
    if control.is_null() {
        Err(last_error("CreateWindowExW control failed"))
    } else {
        Ok(control)
    }
}

unsafe fn show_and_activate(window: HWND) {
    unsafe {
        ShowWindow(window, SW_RESTORE);
        SetForegroundWindow(window);
    }
}

fn autostart_enabled() -> Result<bool, String> {
    let key = wide(RUN_KEY);
    let value = wide(RUN_VALUE);
    let mut value_type = 0;
    let mut byte_count = 0;
    // SAFETY: all pointers are valid for the duration of the synchronous registry calls.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_ANY | RRF_NOEXPAND,
            &mut value_type,
            null_mut(),
            &mut byte_count,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(registry_error(status));
    }
    if value_type != REG_SZ || byte_count == 0 {
        return Ok(false);
    }

    let mut data = vec![0u16; (byte_count as usize).div_ceil(size_of::<u16>())];
    let mut actual_bytes = byte_count;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_ANY | RRF_NOEXPAND,
            &mut value_type,
            data.as_mut_ptr().cast(),
            &mut actual_bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(registry_error(status));
    }
    if value_type != REG_SZ || actual_bytes as usize % size_of::<u16>() != 0 {
        return Ok(false);
    }
    data.truncate(actual_bytes as usize / size_of::<u16>());
    while data.last() == Some(&0) {
        data.pop();
    }

    let mut expected = autostart_command()?;
    expected.pop();
    Ok(data == expected)
}

fn set_autostart(enabled: bool) -> Result<(), String> {
    let key = wide(RUN_KEY);
    let value = wide(RUN_VALUE);
    let status = if enabled {
        let command = autostart_command()?;
        let byte_count = command
            .len()
            .checked_mul(size_of::<u16>())
            .and_then(|length| u32::try_from(length).ok())
            .ok_or_else(|| ui_strings().command_too_long.to_owned())?;
        // SAFETY: command is NUL-terminated and byte_count covers the complete UTF-16 value.
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                REG_SZ,
                command.as_ptr().cast(),
                byte_count,
            )
        }
    } else {
        // SAFETY: the key and value strings are valid and NUL-terminated.
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) }
    };

    if status == ERROR_SUCCESS || (!enabled && status == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        Err(registry_error(status))
    }
}

fn autostart_command() -> Result<Vec<u16>, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("{}: {error}", ui_strings().executable_error))?;
    let mut command = Vec::with_capacity(executable.as_os_str().len() + 16);
    command.push('"' as u16);
    command.extend(executable.as_os_str().encode_wide());
    command.extend("\" --autostart".encode_utf16());
    command.push(0);
    Ok(command)
}

fn tray_icon_data(window: HWND) -> NOTIFYICONDATAW {
    let mut data: NOTIFYICONDATAW = unsafe { zeroed() };
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = window;
    data.uID = TRAY_ICON_ID;
    data
}

fn copy_wide_into<const N: usize>(target: &mut [u16; N], value: &str) {
    let encoded = value.encode_utf16().take(N.saturating_sub(1));
    for (destination, source) in target.iter_mut().zip(encoded) {
        *destination = source;
    }
}

fn show_owned_error(window: HWND, message: &str) {
    let message = wide(&message.replace('\0', " "));
    let title = wide(WINDOW_TITLE);
    // SAFETY: strings live through the synchronous call and window is owned by this thread.
    unsafe {
        MessageBoxW(
            window,
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn ui_strings() -> &'static UiStrings {
    // LANG_RUSSIAN is 0x19; the low ten bits are the primary language identifier.
    if unsafe { GetUserDefaultUILanguage() } & 0x03ff == 0x19 {
        &RUSSIAN
    } else {
        &ENGLISH
    }
}

fn registry_error(status: u32) -> String {
    format!(
        "{} ({status})",
        std::io::Error::from_raw_os_error(status as i32)
    )
}

fn last_error(context: &str) -> String {
    let code = unsafe { GetLastError() };
    format!(
        "{context}: {}",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
