"""Read-only public machine/condition observation; never kills unrelated workloads."""

import json
import platform
import subprocess

import psutil


def capture():
    power = subprocess.run(
        ["/usr/bin/pmset", "-g", "batt"], capture_output=True, text=True, timeout=5
    )
    cpu = psutil.cpu_percent(interval=1.0)
    return {
        "os": platform.mac_ver()[0],
        "arch": platform.machine(),
        "logicalCpus": psutil.cpu_count(),
        "memoryBytes": psutil.virtual_memory().total,
        "systemBusyPercent": cpu,
        "power": "ac"
        if "AC Power" in power.stdout
        else "battery"
        if "Battery Power" in power.stdout
        else "unknown",
        "conditionsMet": power.returncode == 0 and "AC Power" in power.stdout and cpu <= 10,
        "conditions": "AC power and at most 10% total CPU over a one-second pre/post sample; no continuous isolation guarantee",
    }


if __name__ == "__main__":
    print(json.dumps(capture()))
