use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{null, null_mut};

use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Foundation::{
    GetLastError, HWND, LPARAM, LRESULT, WPARAM, ERROR_CLASS_ALREADY_EXISTS,
    ERROR_FILE_NOT_FOUND, ERROR_SUCCESS,
};
use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
use windows_sys::Win32::Graphics::Gdi::{
    GetStockObject, GetSysColorBrush, COLOR_WINDOW, DEFAULT_GUI_FONT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
};
use windows_sys::Win32::UI::Controls::{
    BST_CHECKED, BST_UNCHECKED, EM_SETSEL,
};
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
    NIM_SETVERSION, NIN_SELECT, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowW,
    GetMessageW, GetWindowLongPtrW, IsDialogMessageW, IsWindow, KillTimer, LoadCursorW,
    LoadIconW, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW,
    RegisterWindowMessageW, SendMessageW, SetForegroundWindow, SetTimer,
    SetWindowLongPtrW, SetWindowTextW, ShowWindow, TranslateMessage, BN_CLICKED,
    BS_AUTOCHECKBOX,
    CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT,
    ES_AUTOHSCROLL, ES_READONLY, GWLP_USERDATA, IDC_ARROW, IDI_APPLICATION,
    MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MSG, SIZE_MINIMIZED, SW_HIDE, SW_RESTORE,
    SW_SHOW, WM_APP, WM_CLOSE, WM_COMMAND, WM_COPY, WM_CREATE, WM_DESTROY,
    WM_ENDSESSION, WM_LBUTTONUP, WM_NCCREATE, WM_NCDESTROY, WM_QUERYENDSESSION,
    WM_SETFONT, WM_SIZE, WM_TIMER, WNDCLASSW, WS_CAPTION, WS_CHILD,
    WS_EX_CLIENTEDGE, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP,
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

struct UiStrings {
    heading: &'static str,
    version: &'static str,
    pairing_code: &'static str,
    copy: &'static str,
    autostart: &'static str,
    location_note: &'static str,
    exit: &'static str,
    autostart_error: &'static str,
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
    pairing_error: "Не удалось получить код подключения.",
    executable_error: "Не удалось определить путь к исполняемому файлу",
    command_too_long: "Путь к исполняемому файлу слишком длинный для автозапуска.",
};

struct WindowState {
    get_pairing_code: Box<dyn Fn() -> String + Send>,
    shutdown: CancellationToken,
    strings: &'static UiStrings,
    pairing_edit: Cell<HWND>,
    autostart_checkbox: Cell<HWND>,
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

        let icon = LoadIconW(null_mut(), IDI_APPLICATION);
        if icon.is_null() {
            return Err(last_error("LoadIconW failed"));
        }
        let cursor = LoadCursorW(null_mut(), IDC_ARROW);
        if cursor.is_null() {
            return Err(last_error("LoadCursorW failed"));
        }

        let window_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: icon,
            hCursor: cursor,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
        };
        if RegisterClassW(&window_class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(last_error("RegisterClassW failed"));
        }

        let taskbar_created = RegisterWindowMessageW(taskbar_message_name.as_ptr());
        if taskbar_created == 0 {
            return Err(last_error("RegisterWindowMessageW failed"));
        }

        let state = Box::new(WindowState {
            get_pairing_code,
            shutdown,
            strings: ui_strings(),
            pairing_edit: Cell::new(null_mut()),
            autostart_checkbox: Cell::new(null_mut()),
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
            310,
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

unsafe fn window_proc_inner(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        if create.is_null() || unsafe { (*create).lpCreateParams.is_null() } {
            return 0;
        }
        unsafe {
            SetWindowLongPtrW(
                window,
                GWLP_USERDATA,
                (*create).lpCreateParams as isize,
            );
        }
        return 1;
    }

    let state_pointer = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) as *mut WindowState };
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }

    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(window, GWLP_USERDATA, 0) };
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
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
                        SendMessageW(state.pairing_edit.get(), EM_SETSEL, 0, -1);
                        SendMessageW(state.pairing_edit.get(), WM_COPY, 0, 0);
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

        let heading = unsafe {
            create_control(window, instance, "STATIC", self.strings.heading, WS_CHILD | WS_VISIBLE, 0, 20, 16, 420, 24, 0)?
        };
        let version = format!("{}: {}", self.strings.version, env!("CARGO_PKG_VERSION"));
        let version_control = unsafe {
            create_control(window, instance, "STATIC", &version, WS_CHILD | WS_VISIBLE, 0, 20, 48, 420, 22, 0)?
        };
        let pairing_label = unsafe {
            create_control(window, instance, "STATIC", self.strings.pairing_code, WS_CHILD | WS_VISIBLE, 0, 20, 79, 420, 20, 0)?
        };
        self.pairing_edit.set(unsafe {
            create_control(
                window,
                instance,
                "EDIT",
                "",
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL as u32 | ES_READONLY as u32,
                WS_EX_CLIENTEDGE,
                20,
                102,
                306,
                27,
                0,
            )?
        });
        let copy_button = unsafe {
            create_control(
                window,
                instance,
                "BUTTON",
                self.strings.copy,
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                0,
                334,
                101,
                106,
                29,
                ID_COPY,
            )?
        };
        self.autostart_checkbox.set(unsafe {
            create_control(
                window,
                instance,
                "BUTTON",
                self.strings.autostart,
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX as u32,
                0,
                20,
                143,
                420,
                26,
                ID_AUTOSTART,
            )?
        });
        let note = unsafe {
            create_control(window, instance, "STATIC", self.strings.location_note, WS_CHILD | WS_VISIBLE, 0, 38, 171, 402, 38, 0)?
        };
        let exit_button = unsafe {
            create_control(
                window,
                instance,
                "BUTTON",
                self.strings.exit,
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                0,
                334,
                218,
                106,
                31,
                ID_EXIT,
            )?
        };

        let font = unsafe { GetStockObject(DEFAULT_GUI_FONT) };
        if !font.is_null() {
            for control in [
                heading,
                version_control,
                pairing_label,
                self.pairing_edit.get(),
                copy_button,
                self.autostart_checkbox.get(),
                note,
                exit_button,
            ] {
                unsafe { SendMessageW(control, WM_SETFONT, font as usize, 1) };
            }
        }

        self.refresh_pairing_code();
        if self.last_pairing_code.borrow().is_empty() {
            return Err(self.strings.pairing_error.to_owned());
        }

        match autostart_enabled() {
            Ok(enabled) => unsafe {
                SendMessageW(
                    self.autostart_checkbox.get(),
                    windows_sys::Win32::UI::WindowsAndMessaging::BM_SETCHECK,
                    (if enabled { BST_CHECKED } else { BST_UNCHECKED }) as usize,
                    0,
                );
            },
            Err(error) => show_owned_error(window, &format!("{}: {error}", self.strings.autostart_error)),
        }

        unsafe { self.add_tray_icon(window)? };
        if unsafe { SetTimer(window, TIMER_ID, 1_000, None) } == 0 {
            unsafe { self.remove_tray_icon(window) };
            return Err(last_error("SetTimer failed"));
        }
        Ok(())
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
        *self.last_pairing_code.borrow_mut() = code;
        // No RefCell borrow may span this reentrant call.
        unsafe { SetWindowTextW(self.pairing_edit.get(), text.as_ptr()) };
    }

    unsafe fn change_autostart(&self, window: HWND) {
        let checked = unsafe {
            SendMessageW(
                self.autostart_checkbox.get(),
                windows_sys::Win32::UI::WindowsAndMessaging::BM_GETCHECK,
                0,
                0,
            ) as u32
                == BST_CHECKED
        };
        if let Err(error) = set_autostart(checked) {
            unsafe {
                SendMessageW(
                    self.autostart_checkbox.get(),
                    windows_sys::Win32::UI::WindowsAndMessaging::BM_SETCHECK,
                    (if checked { BST_UNCHECKED } else { BST_CHECKED }) as usize,
                    0,
                );
            }
            show_owned_error(window, &format!("{}: {error}", self.strings.autostart_error));
        }
    }

    unsafe fn add_tray_icon(&self, window: HWND) -> Result<(), String> {
        if self.tray_added.get() {
            return Ok(());
        }
        let mut data = tray_icon_data(window);
        let icon = unsafe { LoadIconW(null_mut(), IDI_APPLICATION) };
        if icon.is_null() {
            return Err(last_error("LoadIconW failed"));
        }
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = WM_TRAY;
        data.hIcon = icon;
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
            0,
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
            0,
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
