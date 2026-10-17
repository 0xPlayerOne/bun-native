//! Native-owner + Bun subprocess fallback probe. Deliberately not a production supervisor.
use std::io::{BufRead,BufReader,Read,Write};
use std::process::{Command,Stdio};
use std::sync::mpsc;
use std::time::{Duration,Instant};
fn main() {
    let args:Vec<String>=std::env::args().collect();
    if args.len()!=3 {eprintln!("usage: bunly-host-probe <bun-executable> <probe-child.ts>");std::process::exit(2);}
    let start=Instant::now();
    let mut child=Command::new(&args[1]).arg(&args[2]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("spawn Bun child");
    let mut stdin=child.stdin.take().unwrap();let stdout=child.stdout.take().unwrap();
    let(tx,rx)=mpsc::sync_channel(8);
    let reader=std::thread::spawn(move||{for line in BufReader::new(stdout.take(65536)).lines(){match line{Ok(line)=>{if tx.send(line).is_err(){break}},Err(_)=>break}}});
    let result=(||->Result<u32,String>{
        if rx.recv_timeout(Duration::from_secs(10)).map_err(|e|e.to_string())? != "ready" {return Err("missing ready".into());}
        stdin.write_all(b"ping\n").map_err(|e|e.to_string())?;stdin.flush().map_err(|e|e.to_string())?;
        let response=rx.recv_timeout(Duration::from_secs(10)).map_err(|e|e.to_string())?;
        let ticks=response.strip_prefix("pong:").ok_or("invalid response")?.parse::<u32>().map_err(|e|e.to_string())?;
        if ticks==0{return Err("Bun timer did not run".into());}Ok(ticks)
    })();
    drop(stdin);
    if result.is_err(){let _=child.kill();}
    let deadline=Instant::now()+Duration::from_secs(2);
    let exited=loop{match child.try_wait(){Ok(Some(status))=>break status.success(),Ok(None) if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(5)),_=>{let _=child.kill();let _=child.wait();break false}}};
    drop(rx);let _=reader.join();
    match result {Ok(ticks) if exited=>println!("{{\"mode\":\"process\",\"timerTicks\":{ticks},\"elapsedMs\":{},\"passed\":true}}",start.elapsed().as_secs_f64()*1000.0),
        other=>{eprintln!("subprocess probe failed: {other:?}; successful exit: {exited}");std::process::exit(1);}}
}
