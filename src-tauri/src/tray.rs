use crate::config::AppSettings;
use crate::{apply_scale_and_save, reset_window_position, AppState};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn setup_tray(app: &AppHandle, initial: &AppSettings) -> tauri::Result<()> {
    let toggle_show = MenuItem::with_id(app, "toggle_show", "显示 / 隐藏小黑猫", true, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(
        app,
        "click_through",
        "锁定鼠标穿透（防误触）",
        true,
        initial.click_through_locked,
        None::<&str>,
    )?;
    let key_bubbles = CheckMenuItem::with_id(
        app,
        "key_bubbles",
        "显示悬浮按键气泡",
        true,
        initial.show_key_bubbles,
        None::<&str>,
    )?;
    let sound_toggle = CheckMenuItem::with_id(
        app,
        "sound_toggle",
        "声音反馈（键盘音/呼噜）",
        true,
        initial.sound_enabled,
        None::<&str>,
    )?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        "always_on_top",
        "始终置顶显示",
        true,
        initial.always_on_top,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        initial.autostart,
        None::<&str>,
    )?;

    let scale_75 = MenuItem::with_id(app, "scale_75", "75%（小巧）", true, None::<&str>)?;
    let scale_100 = MenuItem::with_id(app, "scale_100", "100%（默认）", true, None::<&str>)?;
    let scale_125 = MenuItem::with_id(app, "scale_125", "125%（偏大）", true, None::<&str>)?;
    let scale_150 = MenuItem::with_id(app, "scale_150", "150%（大号）", true, None::<&str>)?;
    let scale_menu = Submenu::with_items(
        app,
        "缩放大小",
        true,
        &[&scale_75, &scale_100, &scale_125, &scale_150],
    )?;

    let reset_pos = MenuItem::with_id(app, "reset_pos", "重置位置到右下角", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出黑猫桌宠", true, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle_show,
            &sep1,
            &click_through,
            &key_bubbles,
            &sound_toggle,
            &always_on_top,
            &scale_menu,
            &reset_pos,
            &autostart,
            &sep2,
            &quit,
        ],
    )?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::with_id("kuro-tray")
        .icon(icon)
        .tooltip("KuroCat 小黑猫桌宠")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(true) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                    }
                }
            }
        })
        .on_menu_event(move |app, event| {
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                "toggle_show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                        }
                    }
                }
                "click_through" => {
                    let mut s = state.settings.lock().unwrap();
                    s.click_through_locked = !s.click_through_locked;
                    let locked = s.click_through_locked;
                    crate::config::save_settings(&s);
                    let _ = click_through.set_checked(locked);
                    let _ = app.emit("kuro-settings", s.clone());
                }
                "key_bubbles" => {
                    let mut s = state.settings.lock().unwrap();
                    s.show_key_bubbles = !s.show_key_bubbles;
                    let enabled = s.show_key_bubbles;
                    crate::config::save_settings(&s);
                    let _ = key_bubbles.set_checked(enabled);
                    let _ = app.emit("kuro-settings", s.clone());
                }
                "sound_toggle" => {
                    let mut s = state.settings.lock().unwrap();
                    s.sound_enabled = !s.sound_enabled;
                    let enabled = s.sound_enabled;
                    crate::config::save_settings(&s);
                    let _ = sound_toggle.set_checked(enabled);
                    let _ = app.emit("kuro-settings", s.clone());
                }
                "always_on_top" => {
                    let mut s = state.settings.lock().unwrap();
                    s.always_on_top = !s.always_on_top;
                    let on_top = s.always_on_top;
                    crate::config::save_settings(&s);
                    let _ = always_on_top.set_checked(on_top);
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_always_on_top(on_top);
                    }
                    let _ = app.emit("kuro-settings", s.clone());
                }
                "autostart" => {
                    let mut s = state.settings.lock().unwrap();
                    let next = !s.autostart;
                    if crate::config::set_windows_autostart(next).is_ok() {
                        s.autostart = next;
                        crate::config::save_settings(&s);
                        let _ = autostart.set_checked(next);
                        let _ = app.emit("kuro-settings", s.clone());
                    }
                }
                "scale_75" => apply_scale_and_save(app, 0.75),
                "scale_100" => apply_scale_and_save(app, 1.0),
                "scale_125" => apply_scale_and_save(app, 1.25),
                "scale_150" => apply_scale_and_save(app, 1.5),
                "reset_pos" => reset_window_position(app),
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
