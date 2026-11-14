// The Windows app's serial port bridge. The web view has no Web Serial, so the page asks this
// code to open the port, and bytes go back and forth as events. All the GRBL logic stays in
// TypeScript, where it is shared with the browser version and covered by tests.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};
use tauri::{AppHandle, Emitter, State};

struct Connection {
    port: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct Serial(Mutex<Option<Connection>>);

#[derive(Serialize)]
struct PortInfo {
    name: String,
    vendor_id: Option<u16>,
    product_id: Option<u16>,
    label: Option<String>,
}

#[tauri::command]
fn serial_list() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(usb) => PortInfo {
                name: p.port_name,
                vendor_id: Some(usb.vid),
                product_id: Some(usb.pid),
                label: usb.product,
            },
            _ => PortInfo { name: p.port_name, vendor_id: None, product_id: None, label: None },
        })
        .collect())
}

fn close_current(serial: &Serial) {
    if let Some(conn) = serial.0.lock().unwrap().take() {
        conn.stop.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn serial_open(app: AppHandle, serial: State<Serial>, name: String, baud: u32) -> Result<(), String> {
    close_current(&serial);
    let port = serialport::new(&name, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| e.to_string())?;
    let mut reader = port.try_clone().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    // GRBL speaks ASCII. The Cubiko's firmware name has a few stray bytes; they become "?" marks.
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("serial-data", text);
                }
                Err(e) if e.kind() == ErrorKind::TimedOut => {}
                Err(_) => {
                    // The cable came out, or the port went away.
                    if !stopped.load(Ordering::SeqCst) {
                        let _ = app.emit("serial-closed", ());
                    }
                    return;
                }
            }
        }
    });

    *serial.0.lock().unwrap() = Some(Connection { port, stop });
    Ok(())
}

/// One character is one byte, so GRBL's single-byte commands (such as 0x85, jog cancel) arrive intact.
#[tauri::command]
fn serial_write(serial: State<Serial>, data: String) -> Result<(), String> {
    let bytes: Vec<u8> = data.chars().map(|c| (c as u32 & 0xff) as u8).collect();
    let mut guard = serial.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("The machine isn't connected.")?;
    conn.port.write_all(&bytes).map_err(|e| e.to_string())?;
    conn.port.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn serial_close(serial: State<Serial>) {
    close_current(&serial);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Serial::default())
        .invoke_handler(tauri::generate_handler![serial_list, serial_open, serial_write, serial_close])
        .run(tauri::generate_context!())
        .expect("error while running Staffy CNC");
}
