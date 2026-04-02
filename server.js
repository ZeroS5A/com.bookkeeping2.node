/**
 * 记账本后端 API 服务 (RESTful) - 支持 MySQL 与 SQLite 双引擎
 * 功能：用户注册/登录、账单增删改查
 * 依赖 (通用)：npm install express cors body-parser
 * 依赖 (若用MySQL)：npm install mysql2
 * 依赖 (若用SQLite)：npm install sqlite3 sqlite
 * 运行：node server.js
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// 1. 加载并解析配置文件
const configPath = path.join(__dirname, 'config.json');
let config = { database: { type: 'mysql' }, server: {} }; // 默认配置
try {
    if (fs.existsSync(configPath)) {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const parsedConfig = JSON.parse(fileContent);
        // 合并配置
        config = { ...config, ...parsedConfig };
    } else {
        console.log('⚠️ 警告: 未找到 config.json，将使用默认配置尝试连接 MySQL');
    }
} catch (err) {
    console.error('❌ 解析 config.json 失败:', err.message);
    process.exit(1);
}

const app = express();
const PORT = config.server.port || 3000;
// 获取数据库类型，默认为 mysql
const DB_TYPE = (config.database.type || 'mysql').toLowerCase();

app.use(cors());
app.use(bodyParser.json());

// ==========================================
// 2. 数据库适配器 (核心抽象层)
// ==========================================
let db; // 统一的数据操作接口

async function initDBConnection() {
    if (DB_TYPE === 'sqlite') {
        let sqlite3, sqlite;
        try {
            // 动态引入，避免不使用 SQLite 时报缺包错误
            sqlite3 = require('sqlite3');
            sqlite = require('sqlite');
        } catch (err) {
            console.error('❌ 缺少 SQLite 依赖，请运行: npm install sqlite3 sqlite');
            process.exit(1);
        }

        const dbFile = config.database.filename || './ledger.db';
        const sqliteDb = await sqlite.open({
            filename: dbFile,
            driver: sqlite3.Database
        });
        
        // 开启 SQLite 的外键支持 (级联删除必备)
        await sqliteDb.run('PRAGMA foreign_keys = ON');

        db = {
            // 统一暴露 execute 方法，抹平不同驱动的返回值差异
            execute: async (sql, params = []) => {
                const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
                if (isSelect) {
                    const rows = await sqliteDb.all(sql, params);
                    return [rows]; // 模拟 mysql2 返回格式 [rows, fields]
                } else {
                    const result = await sqliteDb.run(sql, params);
                    // 模拟 mysql2 返回的 ResultSetHeader
                    return [{ insertId: result.lastID, affectedRows: result.changes }];
                }
            }
        };
        console.log(`✅ 成功连接到 SQLite 数据库 (文件: ${dbFile})`);

    } else if (DB_TYPE === 'mysql') {
        let mysql;
        try {
            mysql = require('mysql2/promise');
        } catch (err) {
            console.error('❌ 缺少 MySQL 依赖，请运行: npm install mysql2');
            process.exit(1);
        }

        const pool = mysql.createPool({
            host: config.database.host || 'localhost',
            port: config.database.port || 3306,
            user: config.database.user || 'root',
            password: config.database.password || '',
            database: config.database.name || 'ledger_db',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        db = {
            execute: async (sql, params) => {
                return await pool.execute(sql, params);
            }
        };
        console.log(`✅ 成功连接到 MySQL 数据库 (${config.database.host})`);
    } else {
        console.error(`❌ 不支持的数据库类型: ${DB_TYPE}`);
        process.exit(1);
    }
}

// 初始化数据库表
const initTables = async () => {
    try {
        // 方言差异处理：SQLite 与 MySQL 自增主键语法不同
        const idColumn = DB_TYPE === 'sqlite'
            ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
            : 'id INT AUTO_INCREMENT PRIMARY KEY';

        // 1. 用户表
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                ${idColumn},
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. 账单表
        await db.execute(`
            CREATE TABLE IF NOT EXISTS transactions (
                ${idColumn},
                user_id INT NOT NULL,
                type VARCHAR(10) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                category_id VARCHAR(50),
                date DATETIME,
                note TEXT,
                counterparty VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        console.log('✅ 数据库表初始化/检查完成');
    } catch (err) {
        console.error('❌ 数据库表初始化失败:', err);
        process.exit(1);
    }
};

// 辅助：方言相关的错误校验和日期格式化
const isDuplicateError = (err) => {
    // 捕获 MySQL 和 SQLite 的唯一约束冲突
    return err.code === 'ER_DUP_ENTRY' || err.code === 'SQLITE_CONSTRAINT';
};

const formatDBDate = (dateStr) => {
    // MySQL 接收 JS Date 对象，SQLite 推荐使用 ISO 字符串
    const d = new Date(dateStr);
    return DB_TYPE === 'sqlite' ? d.toISOString() : d;
};

// ==========================================
// 3. Auth Routes
// ==========================================

// 注册
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: '请输入用户名和密码' });

    try {
        const [result] = await db.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, password]
        );
        res.json({ message: '注册成功', user: { id: result.insertId, username } });
    } catch (err) {
        if (isDuplicateError(err)) return res.status(409).json({ message: '用户名已存在' });
        res.status(500).json({ message: err.message });
    }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.execute(
            'SELECT id, username FROM users WHERE username = ? AND password = ?',
            [username, password]
        );
        if (rows.length > 0) {
            res.json({ message: '登录成功', user: rows[0] });
        } else {
            res.status(401).json({ message: '用户名或密码错误' });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// 4. Transaction Routes
// ==========================================

// 获取当前用户的所有账单
app.get('/api/transactions', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ message: 'Missing userId' });

    try {
        const [rows] = await db.execute(
            'SELECT id, type, amount, category_id as categoryId, date, note, counterparty FROM transactions WHERE user_id = ? ORDER BY date DESC',
            [userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 新增账单
app.post('/api/transactions', async (req, res) => {
    const { userId, type, amount, categoryId, date, note, counterparty } = req.body;
    
    try {
        const dateParam = formatDBDate(date);
        const [result] = await db.execute(
            `INSERT INTO transactions (user_id, type, amount, category_id, date, note, counterparty) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, categoryId, dateParam, note, counterparty]
        );
        res.json({ id: result.insertId, userId, type, amount, categoryId, date, note, counterparty });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 更新账单
app.put('/api/transactions/:id', async (req, res) => {
    const { id } = req.params;
    const { amount, categoryId, date, note, counterparty } = req.body;

    try {
        const dateParam = formatDBDate(date);
        await db.execute(
            `UPDATE transactions SET amount=?, category_id=?, date=?, note=?, counterparty=? WHERE id=?`,
            [amount, categoryId, dateParam, note, counterparty, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 删除账单
app.delete('/api/transactions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM transactions WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// 5. 启动服务
// ==========================================
const startServer = async () => {
    await initDBConnection();
    await initTables();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 服务运行在 http://0.0.0.0:${PORT}`);
        console.log(`🔌 当前使用数据引擎: ${DB_TYPE.toUpperCase()}`);
    });
};

startServer();