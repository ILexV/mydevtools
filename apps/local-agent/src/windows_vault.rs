//! Vault export and import from the agent window: a password prompt, the
//! Windows file dialogs and a summary. Pages have no route to either action,
//! so the password and the exported file never reach a browser.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, COLOR_WINDOW, CreateFontW, DEFAULT_CHARSET,
    DEFAULT_PITCH, DeleteObject, FF_DONTCARE, FW_REGULAR, GetSysColor, GetSysColorBrush, HFONT,
    OUT_DEFAULT_PRECIS, SetBkColor,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::Dialogs::{
    GetOpenFileNameW, GetSaveFileNameW, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
    OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BN_CLICKED, BS_DEFPUSHBUTTON, CREATESTRUCTW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW,
    DestroyWindow, DispatchMessageW, ES_AUTOHSCROLL, ES_PASSWORD, GWLP_USERDATA, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IDC_ARROW, IDC_WAIT,
    IDCANCEL, IDOK, IsDialogMessageW, LoadCursorW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MSG,
    MessageBoxW, PostQuitMessage, RegisterClassExW, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER,
    SendMessageW, SetCursor, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, SetWindowTextW,
    ShowWindow, TranslateMessage, WM_CLOSE, WM_COMMAND, WM_CTLCOLORBTN, WM_CTLCOLORSTATIC,
    WM_NCCREATE, WM_QUIT, WM_SETFONT, WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_EX_CLIENTEDGE,
    WS_EX_DLGMODALFRAME, WS_POPUP, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
};

use crate::model::ApiError;
use crate::vault::{
    MIN_PASSWORD_CHARS, TRANSFER_EXTENSION, TransferSummary, Vault, suggested_file_name,
};

const PROMPT_CLASS: &str = "MyDevToolsLocalAgentPassword";
const BASE_DPI: u32 = 96;
const PROMPT_WIDTH: i32 = 380;
const PATH_CAPACITY: usize = 1024;

pub(crate) struct VaultStrings {
    pub(crate) export: &'static str,
    pub(crate) import: &'static str,
    export_title: &'static str,
    import_title: &'static str,
    export_intro: &'static str,
    import_intro: &'static str,
    password: &'static str,
    repeat: &'static str,
    ok: &'static str,
    cancel: &'static str,
    too_short: &'static str,
    mismatch: &'static str,
    file_type: &'static str,
    exported: &'static str,
    imported: &'static str,
    skipped: &'static str,
    error_password_invalid: &'static str,
    error_file_invalid: &'static str,
    error_full: &'static str,
    error_key: &'static str,
    error_generic: &'static str,
}

pub(crate) static ENGLISH: VaultStrings = VaultStrings {
    export: "Export vault…",
    import: "Import vault…",
    export_title: "Export the vault",
    import_title: "Import a vault",
    export_intro: "The file holds every site's workspaces, secrets and client certificates, encrypted with this password. Anyone with the file and the password can read them.",
    import_intro: "Enter the password the file was exported with. Items with the same name are replaced; everything else stays.",
    password: "Password",
    repeat: "Repeat the password",
    ok: "OK",
    cancel: "Cancel",
    too_short: "Use at least {min} characters.",
    mismatch: "The passwords do not match.",
    file_type: "MyDevTools vault",
    exported: "Exported {sites} sites: {documents} documents, {secrets} secrets, {certificates} client certificates.",
    imported: "Imported {sites} sites: {documents} documents, {secrets} secrets, {certificates} client certificates.",
    skipped: "{skipped} sites were not exported: they have not been opened since the agent was updated. Open them once and export again.",
    error_password_invalid: "The password does not open this file.",
    error_file_invalid: "This is not a MyDevTools vault export, or it is damaged.",
    error_full: "The vault would exceed its limits. Nothing was imported.",
    error_key: "The vault key is not available for this Windows user.",
    error_generic: "The vault could not be read or written.",
};

pub(crate) static RUSSIAN: VaultStrings = VaultStrings {
    export: "Экспорт хранилища…",
    import: "Импорт хранилища…",
    export_title: "Экспорт хранилища",
    import_title: "Импорт хранилища",
    export_intro: "В файл попадут рабочие пространства, секреты и клиентские сертификаты всех сайтов, зашифрованные этим паролем. Любой, у кого есть файл и пароль, сможет их прочитать.",
    import_intro: "Введите пароль, с которым файл экспортирован. Записи с теми же именами заменятся, остальное сохранится.",
    password: "Пароль",
    repeat: "Повторите пароль",
    ok: "ОК",
    cancel: "Отмена",
    too_short: "Нужно не меньше {min} символов.",
    mismatch: "Пароли не совпадают.",
    file_type: "Хранилище MyDevTools",
    exported: "Экспортировано сайтов: {sites}. Документов: {documents}, секретов: {secrets}, клиентских сертификатов: {certificates}.",
    imported: "Импортировано сайтов: {sites}. Документов: {documents}, секретов: {secrets}, клиентских сертификатов: {certificates}.",
    skipped: "Не экспортировано сайтов: {skipped}. Их не открывали после обновления агента. Откройте их один раз и повторите экспорт.",
    error_password_invalid: "Этот пароль не открывает файл.",
    error_file_invalid: "Это не экспорт хранилища MyDevTools, или файл повреждён.",
    error_full: "Хранилище превысит свои пределы. Ничего не импортировано.",
    error_key: "Ключ хранилища недоступен для этого пользователя Windows.",
    error_generic: "Не удалось прочитать или записать хранилище.",
};

/// Asks for a new password, then a file name, and writes the export.
pub(crate) fn export(owner: HWND, vault: &Vault, strings: &'static VaultStrings, title: &str) {
    let Some(password) = ask_password(owner, strings, true) else {
        return;
    };
    let Some(path) = choose_file(owner, strings, true) else {
        return;
    };
    let result = with_wait_cursor(|| vault.export_to(&path, &password));
    drop(password);
    match result {
        Ok(summary) => {
            let mut text = fill(strings.exported, &summary);
            if summary.skipped > 0 {
                text.push_str("\n\n");
                text.push_str(&fill(strings.skipped, &summary));
            }
            message(owner, title, &text, MB_ICONINFORMATION);
        }
        Err(error) => message(owner, title, error_text(strings, &error), MB_ICONERROR),
    }
}

/// Asks for a file, then its password, and merges it into the vault.
pub(crate) fn import(owner: HWND, vault: &Vault, strings: &'static VaultStrings, title: &str) {
    let Some(path) = choose_file(owner, strings, false) else {
        return;
    };
    let Some(password) = ask_password(owner, strings, false) else {
        return;
    };
    let result = with_wait_cursor(|| vault.import_from(&path, &password));
    drop(password);
    match result {
        Ok(summary) => message(
            owner,
            title,
            &fill(strings.imported, &summary),
            MB_ICONINFORMATION,
        ),
        Err(error) => message(owner, title, error_text(strings, &error), MB_ICONERROR),
    }
}

fn error_text(strings: &VaultStrings, error: &ApiError) -> &'static str {
    match error.code {
        "transfer_password_invalid" => strings.error_password_invalid,
        "transfer_file_invalid" => strings.error_file_invalid,
        "vault_full" => strings.error_full,
        "vault_key_unavailable" => strings.error_key,
        _ => strings.error_generic,
    }
}

fn fill(template: &str, summary: &TransferSummary) -> String {
    template
        .replace("{sites}", &summary.sites.to_string())
        .replace("{documents}", &summary.documents.to_string())
        .replace("{secrets}", &summary.secrets.to_string())
        .replace("{certificates}", &summary.certificates.to_string())
        .replace("{skipped}", &summary.skipped.to_string())
}

fn with_wait_cursor<T>(work: impl FnOnce() -> T) -> T {
    // SAFETY: cursor handles are shared system resources; restoring the arrow is best effort.
    unsafe { SetCursor(LoadCursorW(null_mut(), IDC_WAIT)) };
    let result = work();
    unsafe { SetCursor(LoadCursorW(null_mut(), IDC_ARROW)) };
    result
}

fn message(owner: HWND, title: &str, text: &str, icon: u32) {
    let text = wide(&text.replace('\0', " "));
    let title = wide(title);
    // SAFETY: both strings are NUL-terminated and outlive this synchronous call.
    unsafe { MessageBoxW(owner, text.as_ptr(), title.as_ptr(), MB_OK | icon) };
}

/// The Windows save or open dialog, limited to `.mdtvx` files.
fn choose_file(owner: HWND, strings: &VaultStrings, save: bool) -> Option<PathBuf> {
    let filter: Vec<u16> = format!(
        "{} (*.{TRANSFER_EXTENSION})\0*.{TRANSFER_EXTENSION}\0\0",
        strings.file_type
    )
    .encode_utf16()
    .collect();
    let extension = wide(TRANSFER_EXTENSION);
    let title = wide(if save {
        strings.export_title
    } else {
        strings.import_title
    });
    let mut buffer = [0_u16; PATH_CAPACITY];
    if save {
        for (target, source) in buffer
            .iter_mut()
            .zip(suggested_file_name().encode_utf16().take(PATH_CAPACITY - 1))
        {
            *target = source;
        }
    }
    // SAFETY: zeroed is a valid OPENFILENAMEW; every pointer below outlives the call.
    let mut dialog: OPENFILENAMEW = unsafe { zeroed() };
    dialog.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = owner;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrFile = buffer.as_mut_ptr();
    dialog.nMaxFile = PATH_CAPACITY as u32;
    dialog.lpstrDefExt = extension.as_ptr();
    dialog.lpstrTitle = title.as_ptr();
    dialog.Flags = OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | if save {
            OFN_OVERWRITEPROMPT
        } else {
            OFN_FILEMUSTEXIST
        };
    let chosen = unsafe {
        if save {
            GetSaveFileNameW(&mut dialog)
        } else {
            GetOpenFileNameW(&mut dialog)
        }
    };
    if chosen == 0 {
        return None;
    }
    let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

struct Prompt {
    strings: &'static VaultStrings,
    confirm_required: bool,
    password: Cell<HWND>,
    confirm: Cell<HWND>,
    error: Cell<HWND>,
    done: Cell<bool>,
    result: RefCell<Option<String>>,
}

/// A small modal window with one password field, or two for a new password.
/// Enter confirms and Escape cancels.
fn ask_password(
    owner: HWND,
    strings: &'static VaultStrings,
    confirm_required: bool,
) -> Option<String> {
    // SAFETY: the prompt window, its controls and its message loop belong to this thread;
    // `prompt` outlives the window, which is destroyed before this function returns.
    unsafe {
        let instance = GetModuleHandleW(null());
        let class_name = wide(PROMPT_CLASS);
        let window_class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(prompt_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: null_mut(),
        };
        // A second registration fails with "already exists", which is fine.
        RegisterClassExW(&window_class);

        let prompt = Prompt {
            strings,
            confirm_required,
            password: Cell::new(null_mut()),
            confirm: Cell::new(null_mut()),
            error: Cell::new(null_mut()),
            done: Cell::new(false),
            result: RefCell::new(None),
        };
        let title = wide(if confirm_required {
            strings.export_title
        } else {
            strings.import_title
        });
        let style = WS_POPUP | WS_CAPTION | WS_SYSMENU;
        let window = CreateWindowExW(
            WS_EX_DLGMODALFRAME,
            class_name.as_ptr(),
            title.as_ptr(),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            PROMPT_WIDTH,
            200,
            owner,
            null_mut(),
            instance,
            (&prompt as *const Prompt).cast::<c_void>(),
        );
        if window.is_null() {
            message(
                owner,
                strings.export_title,
                &format!("CreateWindowExW failed ({})", GetLastError()),
                MB_ICONERROR,
            );
            return None;
        }
        let dpi = GetDpiForWindow(owner).max(BASE_DPI);
        let font = prompt_font(dpi);
        let height = build_prompt(window, instance, &prompt, dpi, font);
        place_over_owner(window, owner, dpi, height, style);

        EnableWindow(owner, 0);
        ShowWindow(window, SW_SHOW);
        SetForegroundWindow(window);
        SetFocus(prompt.password.get());
        let mut msg: MSG = zeroed();
        while !prompt.done.get() {
            let status = GetMessageW(&mut msg, null_mut(), 0, 0);
            if status == 0 || status == -1 {
                // Keep the application's quit request for the outer loop.
                if msg.message == WM_QUIT {
                    PostQuitMessage(msg.wParam as i32);
                }
                break;
            }
            if IsDialogMessageW(window, &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        EnableWindow(owner, 1);
        DestroyWindow(window);
        if !font.is_null() {
            DeleteObject(font);
        }
        SetForegroundWindow(owner);
        prompt.result.into_inner()
    }
}

/// Lays out the controls at `dpi` and returns the client height.
unsafe fn build_prompt(
    window: HWND,
    instance: *mut c_void,
    prompt: &Prompt,
    dpi: u32,
    font: HFONT,
) -> i32 {
    let scale = |value: i32| scale_for_dpi(value, dpi);
    let strings = prompt.strings;
    let intro = if prompt.confirm_required {
        strings.export_intro
    } else {
        strings.import_intro
    };
    let width = PROMPT_WIDTH - 40;
    let mut y = 14;
    let add = |y: i32,
               class: &str,
               text: &str,
               style: u32,
               ex: u32,
               height: i32,
               x: i32,
               w: i32,
               id: usize|
     -> HWND {
        let class = wide(class);
        let text = wide(text);
        // SAFETY: strings outlive the call; the parent window belongs to this thread.
        let control = unsafe {
            CreateWindowExW(
                ex,
                class.as_ptr(),
                text.as_ptr(),
                WS_CHILD | WS_VISIBLE | style,
                scale(x),
                scale(y),
                scale(w),
                scale(height),
                window,
                id as *mut c_void,
                instance,
                null(),
            )
        };
        if !control.is_null() && !font.is_null() {
            unsafe { SendMessageW(control, WM_SETFONT, font as usize, 1) };
        }
        control
    };
    add(y, "STATIC", intro, 0, 0, 64, 20, width, 0);
    y += 72;
    add(y, "STATIC", strings.password, 0, 0, 18, 20, width, 0);
    y += 20;
    let password_style = WS_TABSTOP | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32;
    prompt.password.set(add(
        y,
        "EDIT",
        "",
        password_style,
        WS_EX_CLIENTEDGE,
        26,
        20,
        width,
        0,
    ));
    y += 34;
    if prompt.confirm_required {
        add(y, "STATIC", strings.repeat, 0, 0, 18, 20, width, 0);
        y += 20;
        prompt.confirm.set(add(
            y,
            "EDIT",
            "",
            password_style,
            WS_EX_CLIENTEDGE,
            26,
            20,
            width,
            0,
        ));
        y += 34;
    }
    prompt
        .error
        .set(add(y, "STATIC", "", 0, 0, 36, 20, width, 0));
    y += 40;
    add(
        y,
        "BUTTON",
        strings.ok,
        WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
        0,
        30,
        PROMPT_WIDTH - 220,
        96,
        IDOK as usize,
    );
    add(
        y,
        "BUTTON",
        strings.cancel,
        WS_TABSTOP,
        0,
        30,
        PROMPT_WIDTH - 116,
        96,
        IDCANCEL as usize,
    );
    scale(y + 44)
}

unsafe fn place_over_owner(window: HWND, owner: HWND, dpi: u32, client_height: i32, style: u32) {
    let mut bounds = RECT {
        left: 0,
        top: 0,
        right: scale_for_dpi(PROMPT_WIDTH, dpi),
        bottom: client_height,
    };
    unsafe { AdjustWindowRectExForDpi(&mut bounds, style, 0, WS_EX_DLGMODALFRAME, dpi) };
    let (width, height) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
    let mut owner_bounds: RECT = unsafe { zeroed() };
    unsafe { GetWindowRect(owner, &mut owner_bounds) };
    let x = owner_bounds.left + ((owner_bounds.right - owner_bounds.left) - width) / 2;
    let y = owner_bounds.top + ((owner_bounds.bottom - owner_bounds.top) - height) / 2;
    unsafe {
        SetWindowPos(
            window,
            null_mut(),
            x,
            y.max(0),
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
}

unsafe fn prompt_font(dpi: u32) -> HFONT {
    let face = wide("Segoe UI");
    unsafe {
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
            face.as_ptr(),
        )
    }
}

unsafe extern "system" fn prompt_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        if message == WM_NCCREATE {
            let create = lparam as *const CREATESTRUCTW;
            if !create.is_null() {
                SetWindowLongPtrW(window, GWLP_USERDATA, (*create).lpCreateParams as isize);
            }
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let prompt = GetWindowLongPtrW(window, GWLP_USERDATA) as *const Prompt;
        if prompt.is_null() {
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let prompt = &*prompt;
        match message {
            WM_COMMAND if (wparam >> 16) as u32 == BN_CLICKED => {
                match (wparam & 0xffff) as i32 {
                    IDOK => submit(prompt),
                    IDCANCEL => prompt.done.set(true),
                    _ => {}
                }
                0
            }
            WM_CLOSE => {
                prompt.done.set(true);
                0
            }
            WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => {
                SetBkColor(wparam as _, GetSysColor(COLOR_WINDOW));
                GetSysColorBrush(COLOR_WINDOW) as LRESULT
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

/// Checks a new password's length and repeat; an existing one only needs text.
fn submit(prompt: &Prompt) {
    let password = read_text(prompt.password.get());
    let problem = if password.is_empty() {
        Some(String::new())
    } else if prompt.confirm_required && password.chars().count() < MIN_PASSWORD_CHARS {
        Some(
            prompt
                .strings
                .too_short
                .replace("{min}", &MIN_PASSWORD_CHARS.to_string()),
        )
    } else if prompt.confirm_required && read_text(prompt.confirm.get()) != password {
        Some(prompt.strings.mismatch.to_owned())
    } else {
        None
    };
    match problem {
        Some(text) => {
            let text = wide(&text);
            // SAFETY: the error label belongs to the prompt window on this thread.
            unsafe {
                SetWindowTextW(prompt.error.get(), text.as_ptr());
                SetFocus(prompt.password.get());
            }
        }
        None => {
            *prompt.result.borrow_mut() = Some(password);
            prompt.done.set(true);
        }
    }
}

fn read_text(control: HWND) -> String {
    // SAFETY: the buffer is sized from the control's own length plus the terminator.
    unsafe {
        let length = GetWindowTextLengthW(control).max(0) as usize;
        let mut buffer = vec![0_u16; length + 1];
        let copied =
            GetWindowTextW(control, buffer.as_mut_ptr(), buffer.len() as i32).max(0) as usize;
        let text = String::from_utf16_lossy(&buffer[..copied]);
        buffer.iter_mut().for_each(|unit| *unit = 0);
        text
    }
}

fn scale_for_dpi(value: i32, dpi: u32) -> i32 {
    ((i64::from(value) * i64::from(dpi) + i64::from(BASE_DPI / 2)) / i64::from(BASE_DPI)) as i32
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
