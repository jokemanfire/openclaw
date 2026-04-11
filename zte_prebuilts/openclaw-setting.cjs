// ============================================================================
// 文件: openclaw-setting.cjs
// ============================================================================

const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

console.log('[Bionic Patch] Initializing OpenClaw Android Environment...');

// 1. DNS 修复补丁
const defaultLookup = (hostname, options, callback) => {
    return dns.lookup(hostname, options, callback);
};
if (http.globalAgent) http.globalAgent.options.lookup = defaultLookup;
if (https.globalAgent) https.globalAgent.options.lookup = defaultLookup;

// ============================================================================
// 【核心修改区】：强制指定 Home 目录到 openclaw_run 内部
// ============================================================================
const ASSISTANT_API_PORT = 18790;

// 1. 强制写死路径内部的 home
const HOME_DIR = '/data/vendor/openclaw/home/';

// 2. 【极其关键】强行覆盖进程的环境变量！
// 这样即使你外部的启动命令写错了，OpenClaw 核心代码也会乖乖来这里读配置
process.env.HOME = HOME_DIR;

const CONFIG_DIR = path.join(HOME_DIR, '.openclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'openclaw.json');

let isRestarting = false;

// 深度合并函数
function deepMerge(target, source) {
    for (const key in source) {
        if (source[key] instanceof Object && !Array.isArray(source[key])) {
            if (!target[key]) target[key] = {};
            deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

const configServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/config') {
        
        if (isRestarting) {
            res.writeHead(429);
            return res.end('Rebooting...');
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', () => {
            try {
                const newSettings = JSON.parse(body);
                
                // 确保 .openclaw 文件夹存在
                if (!fs.existsSync(CONFIG_DIR)) {
                    fs.mkdirSync(CONFIG_DIR, { recursive: true });
                }
                
                // 读取现有的配置文件
                let currentSettings = {};
                if (fs.existsSync(CONFIG_FILE)) {
                    try {
                        const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
                        if (fileContent.trim() !== '') currentSettings = JSON.parse(fileContent);
                    } catch (e) { console.warn('Old config invalid, ignoring.'); }
                }
                
                // 合并并写入
                const finalSettings = deepMerge(currentSettings, newSettings);
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(finalSettings, null, 2), 'utf8');
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: "Success! Wrote to openclaw_run/home/.openclaw/openclaw.json" }));
                
                isRestarting = true;
                console.log('[Bionic Patch] Config applied. Exiting for restart...');
                setTimeout(() => { process.exit(0); }, 500);

            } catch (err) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

configServer.listen(ASSISTANT_API_PORT, '127.0.0.1', () => {
    console.log(`[Bionic Patch] API running. Target config: ${CONFIG_FILE}`);
});
