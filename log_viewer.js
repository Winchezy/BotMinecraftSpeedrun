const express = require('express');
const fs = require('fs');
const path = require('path');
const { Tail } = require('tail');

const app = express();
const PORT = 3000;

// Serve static HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'log_viewer.html'));
});

// SSE endpoint for real-time logs
app.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send existing logs first
    const logPath = path.join(__dirname, 'bot_debug.log');

    try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.split('\n').slice(-200); // Last 200 lines
        res.write(`data: ${JSON.stringify({ type: 'initial', lines })}\n\n`);
    } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Could not read log file' })}\n\n`);
    }

    // Watch for new lines
    const tail = new Tail(logPath, {
        fromBeginning: false,
        follow: true,
        useWatchFile: true
    });

    tail.on('line', (line) => {
        res.write(`data: ${JSON.stringify({ type: 'new', line })}\n\n`);
    });

    tail.on('error', (error) => {
        console.error('Tail error:', error);
    });

    // Clean up on disconnect
    req.on('close', () => {
        tail.unwatch();
        res.end();
    });
});

// Get log stats
app.get('/logs/stats', (req, res) => {
    const logPath = path.join(__dirname, 'bot_debug.log');

    try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.split('\n');

        const stats = {
            totalLines: lines.length,
            errors: lines.filter(l => l.includes('Error') || l.includes('error')).length,
            combat: lines.filter(l => l.includes('Combat') || l.includes('HOSTILE') || l.includes('Threat')).length,
            mining: lines.filter(l => l.includes('Mine_') || l.includes('Dig')).length,
            survival: lines.filter(l => l.includes('[Survival]')).length
        };

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: 'Could not read log file' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Log Viewer running at http://localhost:${PORT}`);
    console.log(`📊 Open in browser to see real-time logs!`);
});
