//! Comparable native-owner/Bun-child lifecycle fixture, not a production supervisor.
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn generation(bun: &str, script: &str, index: u32, fault: &str) -> Result<String, String> {
    let started = Instant::now();
    let mut child = Command::new(bun).arg(script).arg(index.to_string()).arg(fault)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("missing stdin")?;
    let output = child.stdout.take().ok_or("missing stdout")?;
    let (tx, rx) = mpsc::sync_channel(8);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output.take(1024 * 1024)).lines() {
            match line { Ok(line) => if tx.send(line).is_err() { break; }, Err(_) => break }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut received = 0u32;
    let mut wake_returns = 0u32;
    let result = (|| -> Result<(u32, u32, bool), String> {
        let ready = rx.recv_timeout(Duration::from_secs(2));
        wake_returns += 1;
        if fault == "pre-register-exit" {
            return if ready.is_err() { Ok((0, 0, true)) } else { Err("unexpected ready".into()) };
        }
        if ready.map_err(|e| e.to_string())? != "ready" { return Err("missing ready".into()); }
        input.write_all(b"start\n").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())?;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now()).ok_or("generation deadline")?;
            let wait = if fault == "hang" || fault == "idle-timeout" { Duration::from_millis(400) } else { remaining };
            let line = rx.recv_timeout(wait);
            wake_returns += 1;
            if matches!(line, Err(mpsc::RecvTimeoutError::Timeout)) && (fault == "hang" || fault == "idle-timeout") {
                return Ok((0, 0, true));
            }
            let line = line.map_err(|e| e.to_string())?;
            if line.starts_with("{\"event\":\"phase\"") { println!("{line}"); continue; }
            if let Some(value) = line.strip_prefix("value:") {
                let value = value.parse::<u32>().map_err(|e| e.to_string())?;
                if value != index * 1024 + received { return Err("incorrect generation/order".into()); }
                received += 1;
                writeln!(input, "ack:{value}").map_err(|e| e.to_string())?;
                input.flush().map_err(|e| e.to_string())?;
            } else if let Some(value) = line.strip_prefix("result:") {
                let fields = value.split(':').map(str::parse::<u32>).collect::<Result<Vec<u32>, _>>().map_err(|e| e.to_string())?;
                if fields.len() != 3 || fields[0] != received { return Err("invalid result".into()); }
                let expected = if fault == "callback" { 8 } else { 256 };
                if received != expected || (fault == "none" && (fields[1] < 15 || fields[2] == 0)) { return Err("incomplete workload".into()); }
                input.write_all(b"release\n").map_err(|e| e.to_string())?;
                input.flush().map_err(|e| e.to_string())?;
                return Ok((fields[1], fields[2], fault != "none"));
            } else { return Err("invalid child frame".into()); }
        }
    })();
    drop(input);
    if result.is_err() || fault == "hang" || fault == "idle-timeout" { let _ = child.kill(); }
    let exit_deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < exit_deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => { let _ = child.kill(); let _ = child.wait(); break None; }
        }
    };
    drop(rx);
    let _ = reader.join();
    let (gc, ticks, expected_fault) = result?;
    let status = status.ok_or("child did not exit within shutdown deadline")?;
    if fault == "pre-register-exit" && status.code() != Some(23) { return Err("incorrect early-exit status".into()); }
    if (fault == "none" || fault == "callback") && !status.success() { return Err("child failed after result".into()); }
    Ok(format!("{{\"generation\":{index},\"fault\":\"{fault}\",\"received\":{received},\"gcCycles\":{gc},\"ticks\":{ticks},\"expectedFaultObserved\":{expected_fault},\"nativeReceiveReturns\":{wake_returns},\"elapsedMs\":{}}}", started.elapsed().as_secs_f64() * 1000.0))
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--crash-fixture") {
        std::process::abort();
    }
    if args.len() != 3 { eprintln!("Expected Bun executable and process-generation.ts"); std::process::exit(2); }
    let mut faults = vec!["none"; 20];
    faults.extend(["callback", "none", "idle-timeout", "none", "pre-register-exit", "none", "hang", "none"]);
    let mut results = Vec::new();
    for (index, fault) in faults.iter().enumerate() {
        match generation(&args[1], &args[2], index as u32, fault) {
            Ok(result) => results.push(result),
            Err(error) => { eprintln!("generation {index}/{fault}: {error}"); std::process::exit(1); }
        }
    }
    println!("{{\"schema\":1,\"mode\":\"process\",\"passed\":true,\"generations\":{},\"results\":[{}],\"scope\":\"native-owner process fixture; not CEF; receive returns are not kernel wakeups\"}}", results.len(), results.join(","));
}
