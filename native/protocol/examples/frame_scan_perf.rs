//! Reader-only timing for complete and fragmented native command frames.
//! Does not measure IPC, GPUI, application code, or rendering.
use bun_native_protocol::CommandReader;
use std::hint::black_box;
use std::io::{self, BufRead, Read};
use std::time::Instant;

struct Fragment<'a> {
    bytes: &'a [u8],
    position: usize,
    chunk: usize,
}
impl Read for Fragment<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let source = self.fill_buf()?;
        let n = source.len().min(out.len());
        out[..n].copy_from_slice(&source[..n]);
        self.consume(n);
        Ok(n)
    }
}
impl BufRead for Fragment<'_> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        Ok(&self.bytes[self.position..self.bytes.len().min(self.position + self.chunk)])
    }
    fn consume(&mut self, amount: usize) {
        self.position += amount;
    }
}
fn main() {
    let samples: usize = std::env::args()
        .nth(1)
        .map(|v| v.parse().unwrap())
        .unwrap_or(10_000);
    for (name, text_len, chunk) in [
        ("small", 16, 8192),
        ("medium", 2048, 8192),
        ("large", 12_000, 8192),
        ("fragmented", 12_000, 128),
    ] {
        let frame = format!(
            "{{\"id\":1,\"type\":\"batch\",\"window_id\":1,\"base_revision\":0,\"operations\":[{{\"type\":\"set\",\"node_id\":1,\"element\":{{\"kind\":\"text\",\"text\":\"{}\"}}}}]}}\n",
            "a".repeat(text_len)
        );
        let mut reader = CommandReader::default();
        let mut elapsed = Vec::new();
        for round in 0..9 {
            let start = Instant::now();
            for _ in 0..samples {
                let mut source = Fragment {
                    bytes: frame.as_bytes(),
                    position: 0,
                    chunk,
                };
                black_box(reader.read(&mut source).unwrap().unwrap());
                assert_eq!(source.position, frame.len());
            }
            if round >= 2 {
                elapsed.push(start.elapsed().as_nanos() as f64 / samples as f64);
            }
        }
        elapsed.sort_by(f64::total_cmp);
        println!(
            "{name} bytes={} samples={samples} median_ns={:.2} rounds={elapsed:?}",
            frame.len(),
            elapsed[elapsed.len() / 2]
        );
    }
}
