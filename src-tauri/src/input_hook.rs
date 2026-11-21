use serde::Serialize;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputEvent {
    KeyDown {
        vk: u32,
        scan: u32,
        repeat: bool,
    },
    KeyUp {
        vk: u32,
        scan: u32,
    },
    MouseDown {
        button: String,
    },
    MouseUp {
        button: String,
    },
    MouseWheel {
        delta: i16,
    },
    MouseMove {
        x: i32,
        y: i32,
        nx: f64,
        ny: f64,
    },
}

enum RawHookMsg {
    KeyDown { vk: u32, scan: u32 },
    KeyUp { vk: u32, scan: u32 },
    MouseDown(&'static str),
    MouseUp(&'static str),
    MouseWheel(i16),
    MouseMove { x: i32, y: i32 },
}

static HOOK_TX: OnceLock<mpsc::Sender<RawHookMsg>> = OnceLock::new();

pub fn start_global_hooks(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<RawHookMsg>();
    let _ = HOOK_TX.set(tx);

    // Dispatcher thread: deduplicates held key repeats & throttles mouse moves to ~60Hz
    std::thread::spawn(move || {
        let mut pressed = [false; 256];
        let mut last_mouse_emit = Instant::now() - Duration::from_secs(1);

        while let Ok(msg) = rx.recv() {
            match msg {
                RawHookMsg::KeyDown { vk, scan } => {
                    let repeat = if (vk as usize) < 256 {
                        let was = pressed[vk as usize];
                        pressed[vk as usize] = true;
                        was
                    } else {
                        false
                    };
                    let _ = app.emit("kuro-input", InputEvent::KeyDown { vk, scan, repeat });
                }
                RawHookMsg::KeyUp { vk, scan } => {
                    if (vk as usize) < 256 {
                        pressed[vk as usize] = false;
                    }
                    let _ = app.emit("kuro-input", InputEvent::KeyUp { vk, scan });
                }
                RawHookMsg::MouseDown(btn) => {
                    let _ = app.emit(
                        "kuro-input",
                        InputEvent::MouseDown {
                            button: btn.to_string(),
                        },
                    );
                }
                RawHookMsg::MouseUp(btn) => {
                    let _ = app.emit(
                        "kuro-input",
                        InputEvent::MouseUp {
                            button: btn.to_string(),
                        },
                    );
                }
                RawHookMsg::MouseWheel(delta) => {
                    let _ = app.emit("kuro-input", InputEvent::MouseWheel { delta });
                }
                RawHookMsg::MouseMove { x, y } => {
                    let now = Instant::now();
                    if now.duration_since(last_mouse_emit) >= Duration::from_millis(16) {
                        last_mouse_emit = now;
                        let (nx, ny) = normalize_screen_point(x, y);
                        let _ = app.emit("kuro-input", InputEvent::MouseMove { x, y, nx, ny });
                    }
                }
            }
        }
    });

    #[cfg(windows)]
    std::thread::spawn(|| {
        run_windows_hook_loop();
    });
}

#[cfg(windows)]
fn normalize_screen_point(x: i32, y: i32) -> (f64, f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN) as f64;
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN) as f64;
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as f64;
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as f64;
        let nx = ((x as f64 - vx) / vw).clamp(0.0, 1.0);
        let ny = ((y as f64 - vy) / vh).clamp(0.0, 1.0);
        (nx, ny)
    }
}

#[cfg(not(windows))]
fn normalize_screen_point(_x: i32, _y: i32) -> (f64, f64) {
    (0.5, 0.5)
}

#[cfg(windows)]
unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        let msg = wparam as u32;
        if let Some(tx) = HOOK_TX.get() {
            match msg {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    let _ = tx.send(RawHookMsg::KeyDown {
                        vk: kb.vkCode,
                        scan: kb.scanCode,
                    });
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    let _ = tx.send(RawHookMsg::KeyUp {
                        vk: kb.vkCode,
                        scan: kb.scanCode,
                    });
                }
                _ => {}
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

#[cfg(windows)]
unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    if code >= 0 {
        let ms = &*(lparam as *const MSLLHOOKSTRUCT);
        let msg = wparam as u32;
        if let Some(tx) = HOOK_TX.get() {
            match msg {
                WM_MOUSEMOVE => {
                    let _ = tx.send(RawHookMsg::MouseMove {
                        x: ms.pt.x,
                        y: ms.pt.y,
                    });
                }
                WM_LBUTTONDOWN => {
                    let _ = tx.send(RawHookMsg::MouseDown("left"));
                }
                WM_LBUTTONUP => {
                    let _ = tx.send(RawHookMsg::MouseUp("left"));
                }
                WM_RBUTTONDOWN => {
                    let _ = tx.send(RawHookMsg::MouseDown("right"));
                }
                WM_RBUTTONUP => {
                    let _ = tx.send(RawHookMsg::MouseUp("right"));
                }
                WM_MBUTTONDOWN => {
                    let _ = tx.send(RawHookMsg::MouseDown("middle"));
                }
                WM_MBUTTONUP => {
                    let _ = tx.send(RawHookMsg::MouseUp("middle"));
                }
                WM_MOUSEWHEEL => {
                    let delta = ((ms.mouseData >> 16) & 0xffff) as i16;
                    let _ = tx.send(RawHookMsg::MouseWheel(delta));
                }
                _ => {}
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

#[cfg(windows)]
fn run_windows_hook_loop() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
    };

    unsafe {
        let hmod = GetModuleHandleW(std::ptr::null());
        let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), hmod, 0);
        let ms_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), hmod, 0);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}

        if !kb_hook.is_null() {
            UnhookWindowsHookEx(kb_hook);
        }
        if !ms_hook.is_null() {
            UnhookWindowsHookEx(ms_hook);
        }
    }
}
