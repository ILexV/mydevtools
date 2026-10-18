#![cfg_attr(windows, windows_subsystem = "windows")]

mod http_client;
mod model;
mod policy;
mod server;
mod state;
#[cfg(windows)]
mod windows_shell;

#[cfg(test)]
mod security_tests;

use std::{collections::HashSet, net::Ipv4Addr, sync::Arc, time::Duration};

use clap::Parser;
use state::{AgentConfig, AgentState};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

const DEFAULT_PORT: u16 = 48_732;
const PRODUCTION_ORIGIN: &str = "https://mydevtools.app";

#[derive(Debug, Parser)]
#[command(version, about = "MyDevTools local capability agent")]
struct Args {
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long, value_parser = parse_origin)]
    origin: Option<String>,

    #[arg(long)]
    allow_private: bool,

    #[arg(long, hide = true)]
    autostart: bool,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        #[cfg(windows)]
        windows_shell::show_error(&error);
        #[cfg(not(windows))]
        eprintln!("MyDevTools Local Agent: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = Args::parse();
    if args.port == 0 {
        return Err("--port must be between 1 and 65535".to_owned());
    }

    #[cfg(windows)]
    if windows_shell::show_existing() {
        return Ok(());
    }

    let mut allowed_origins = HashSet::from([PRODUCTION_ORIGIN.to_owned()]);
    if let Some(origin) = args.origin {
        allowed_origins.insert(origin);
    }
    let state = AgentState::new(AgentConfig {
        port: args.port,
        allow_private: args.allow_private,
        allowed_origins,
    });
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, args.port))
        .await
        .map_err(|error| format!("cannot listen on 127.0.0.1:{}: {error}", args.port))?;
    let shutdown = CancellationToken::new();
    let maintenance = tokio::spawn(maintain_state(Arc::clone(&state), shutdown.clone()));

    #[cfg(windows)]
    let result = run_windows(listener, state, shutdown.clone(), args.autostart).await;
    #[cfg(not(windows))]
    let result = run_console(listener, state, shutdown.clone()).await;

    shutdown.cancel();
    let _ = maintenance.await;
    result
}

async fn maintain_state(state: Arc<AgentState>, shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                state.revoke_all();
                break;
            }
            _ = interval.tick() => {
                state.rotate_pairing_if_expired();
                state.expire_sessions();
            }
        }
    }
}

#[cfg(not(windows))]
async fn run_console(
    listener: TcpListener,
    state: Arc<AgentState>,
    shutdown: CancellationToken,
) -> Result<(), String> {
    println!("MyDevTools Local Agent {}", env!("CARGO_PKG_VERSION"));
    println!("Listening on http://127.0.0.1:{}", state.config.port);
    println!(
        "Private network access: {}",
        if state.config.allow_private {
            "enabled"
        } else {
            "disabled"
        }
    );

    let mut pairing_codes = state.pairing_codes();
    println!("Pairing code: {}", &*pairing_codes.borrow_and_update());
    let print_shutdown = shutdown.clone();
    let printer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = print_shutdown.cancelled() => break,
                changed = pairing_codes.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    println!("Pairing code: {}", &*pairing_codes.borrow_and_update());
                }
            }
        }
    });

    let server_shutdown = shutdown.clone();
    let mut server_task = tokio::spawn(server::serve(listener, state, server_shutdown));
    let result = tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.map_err(|error| format!("cannot wait for Ctrl+C: {error}"))?;
            shutdown.cancel();
            server_task.await
        }
        result = &mut server_task => result,
    };
    shutdown.cancel();
    let _ = printer.await;
    result
        .map_err(|error| format!("local server task failed: {error}"))?
        .map_err(|error| format!("local server failed: {error}"))
}

#[cfg(windows)]
async fn run_windows(
    listener: TcpListener,
    state: Arc<AgentState>,
    shutdown: CancellationToken,
    start_hidden: bool,
) -> Result<(), String> {
    let pairing_codes = state.pairing_codes();
    let get_pairing_code: Box<dyn Fn() -> String + Send> =
        Box::new(move || (*pairing_codes.borrow()).clone());
    let gui_shutdown = shutdown.clone();
    let mut gui_task = tokio::task::spawn_blocking(move || {
        windows_shell::run(get_pairing_code, gui_shutdown, start_hidden)
    });
    let server_shutdown = shutdown.clone();
    let mut server_task = tokio::spawn(server::serve(listener, state, server_shutdown));

    let (server_result, gui_result, server_stopped_first) = tokio::select! {
        result = &mut server_task => {
            let expected = shutdown.is_cancelled();
            shutdown.cancel();
            (result, gui_task.await, !expected)
        }
        result = &mut gui_task => {
            shutdown.cancel();
            (server_task.await, result, false)
        }
    };

    gui_result
        .map_err(|error| format!("window task failed: {error}"))??;
    server_result
        .map_err(|error| format!("local server task failed: {error}"))?
        .map_err(|error| format!("local server failed: {error}"))?;
    if server_stopped_first {
        return Err("local server stopped unexpectedly".to_owned());
    }
    Ok(())
}

fn parse_origin(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value).map_err(|_| "origin must be an absolute HTTP(S) origin")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || parsed.origin().ascii_serialization() != value
    {
        return Err("origin must be exact, for example http://127.0.0.1:4321".to_owned());
    }
    Ok(value.to_owned())
}
