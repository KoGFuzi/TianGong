<?php
// @tiangong-tool {"name":"dns_lookup","description":"DNS 解析工具，查询域名对应的 A/AAAA/CNAME 记录。适用于需要获取目标 IP 地址或验证域名解析的场景。","agents":["research"],"inputs":{"domain":{"type":"string","description":"要查询的域名","required":true},"record_type":{"type":"string","description":"记录类型：A、AAAA、CNAME、MX、TXT（默认 A）"}}}

/**
 * 示例 PHP 工具 — DNS 解析器
 *
 * 参数通过 $argv[1] 以 JSON 字符串传入：
 *   {"domain": "example.com", "record_type": "A"}
 *
 * 结果通过 stdout 输出，引擎捕获为工具返回值。
 */

$args = json_decode($argv[1] ?? '{}', true);
$domain = $args['domain'] ?? '';
$recordType = strtoupper($args['record_type'] ?? 'A');

if (empty($domain)) {
    echo json_encode(['error' => 'Missing required argument: domain'], JSON_UNESCAPED_UNICODE);
    exit(1);
}

// 校验记录类型
$validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
if (!in_array($recordType, $validTypes, true)) {
    echo json_encode(['error' => "Invalid record type: {$recordType}. Valid: " . implode(', ', $validTypes)], JSON_UNESCAPED_UNICODE);
    exit(1);
}

// 执行 DNS 查询
$records = @dns_get_record($domain, match ($recordType) {
    'A'     => DNS_A,
    'AAAA'  => DNS_AAAA,
    'CNAME' => DNS_CNAME,
    'MX'    => DNS_MX,
    'TXT'   => DNS_TXT,
    'NS'    => DNS_NS,
    default => DNS_A,
});

if ($records === false) {
    echo json_encode([
        'domain' => $domain,
        'record_type' => $recordType,
        'error' => 'DNS query failed or no records found',
    ], JSON_UNESCAPED_UNICODE);
    exit(0);
}

$result = [
    'domain' => $domain,
    'record_type' => $recordType,
    'count' => count($records),
    'records' => array_map(function ($r) use ($recordType) {
        $ipKey = match ($recordType) {
            'A' => 'ip',
            'AAAA' => 'ipv6',
            'CNAME' => 'target',
            'MX' => 'target',
            'TXT' => 'txt',
            'NS' => 'target',
            default => 'ip',
        };
        return [
            'host' => $r['host'] ?? '',
            'value' => $r[$ipKey] ?? '',
            'ttl' => $r['ttl'] ?? 0,
        ];
    }, $records),
    'summary' => count($records) . ' 条 ' . $recordType . ' 记录',
];

echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
