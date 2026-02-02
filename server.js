/**
 * 记账本后端 API 服务 (RESTful)
 * 功能：用户注册/登录、账单增删改查
 * 依赖：express, mysql2, cors, body-parser, dotenv
 * 运行：node server.js
 */

require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// 数据库连接池
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ledger_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 初始化数据库表
const initDB = async () => {
    try {
        const conn = await pool.getConnection();
        
        // 1. 用户表
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL, -- 生产环境请使用 bcrypt 加密
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. 账单表 (关联 user_id)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                type VARCHAR(10) NOT NULL, -- 'income' or 'expense'
                amount DECIMAL(10, 2) NOT NULL,
                category_id VARCHAR(50),
                date DATETIME,
                note TEXT,
                counterparty VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        console.log('✅ 数据库初始化完成');
        conn.release();
    } catch (err) {
        console.error('❌ 数据库初始化失败:', err);
    }
};
initDB();

// --- Auth Routes ---

// 注册
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: '请输入用户名和密码' });

    try {
        const [result] = await pool.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, password]
        );
        res.json({ message: '注册成功', user: { id: result.insertId, username } });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: '用户名已存在' });
        res.status(500).json({ message: err.message });
    }
});

// 登录 (简单实现，返回用户信息用于前端状态，生产环境应用 JWT)
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute(
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

// --- Transaction Routes ---

// 获取当前用户的所有账单
app.get('/api/transactions', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ message: 'Missing userId' });

    try {
        const [rows] = await pool.execute(
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
        const [result] = await pool.execute(
            `INSERT INTO transactions (user_id, type, amount, category_id, date, note, counterparty) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, categoryId, new Date(date), note, counterparty]
        );
        // 返回新增的完整对象（包含生成的 ID）
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
        await pool.execute(
            `UPDATE transactions SET amount=?, category_id=?, date=?, note=?, counterparty=? WHERE id=?`,
            [amount, categoryId, new Date(date), note, counterparty, id]
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
        await pool.execute('DELETE FROM transactions WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 服务运行在端口 ${PORT}`);
});