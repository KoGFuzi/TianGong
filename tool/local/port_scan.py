#!/usr/bin/env python3
# @tiangong-tool {"name":"port_scan","description":"对目标主机进行端口扫描（基于 Python socket）。适用于需要快速检测常用端口开放状态的场景。","agents":["operator"],"inputs":{"target":{"type":"string","description":"目标主机或 IP 地址","required":true},"ports":{"type":"string","description":"要扫描的端口列表，逗号分隔，默认扫描常用端口"}}}

"""
示例 Python 工具 — 端口扫描器

参数通过 sys.argv[1] 以 JSON 字符串传入：
  {"target": "127.0.0.1", "ports": "80,443,8080"}

结果通过 stdout 输出，引擎会捕获为工具返回值。
"""

import json
import sys
import socket


DEFAULT_PORTS = "21,22,23,25,53,80,110,143,443,993,995,3306,3389,5432,6379,8080,8443,27017"


def scan_port(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def main():
    raw_args = sys.argv[1] if len(sys.argv) > 1 else '{}'
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON arguments"}))
        sys.exit(1)

    target = args.get("target", "")
    if not target:
        print(json.dumps({"error": "Missing required argument: target"}))
        sys.exit(1)

    ports_str = args.get("ports", DEFAULT_PORTS)
    ports = []
    for p in ports_str.split(","):
        p = p.strip()
        if p.isdigit():
            ports.append(int(p))

    open_ports = []
    closed_ports = []
    for port in ports:
        if scan_port(target, port):
            open_ports.append(port)
        else:
            closed_ports.append(port)

    result = {
        "target": target,
        "scanned": len(ports),
        "open": open_ports,
        "closed_count": len(closed_ports),
        "summary": f"扫描 {len(ports)} 个端口，{len(open_ports)} 个开放" if ports else "无端口扫描",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
