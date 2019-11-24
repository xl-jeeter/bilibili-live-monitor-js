'use strict';

const net = require('net');

const UTF8ArrayToStr = require('../util/conversion.js').UTF8ArrayToStr;
const StrToUTF8Array = require('../util/conversion.js').StrToUTF8Array;
const roomidEmitter = require('../global/config.js').roomidEmitter;
const config = require('../global/config.js');
const wsUri = require('../global/config.js').wsUri;
const cprint = require('../util/printer.js');
const colors = require('colors/safe');

class BilibiliSocket {

    constructor(roomid, uid) {
        this.host = wsUri.host;
        this.port = wsUri.port;

        this.roomid = roomid;
        this.uid = uid;
        this.socket = null;
        this.emitter = roomidEmitter;
        this.closed_by_user = false;

        this.handshake = this.prepareData(7, JSON.stringify({
            'roomid': this.roomid, 
            'uid': this.uid, 
        }));
        this.heartbeat = this.prepareData(2, '');
        this.heartbeatTask = null;

        this.buffer = Buffer.alloc(0);
        this.totalLength = -1;

        this.callbackOnClose = null;
        this.healthCheck = null;
        this.lastRead = 0;
    }

    run() {
        this.socket = net.createConnection({
            'host': this.host, 
            'port': this.port,
        }).setKeepAlive(true); // .setNoDelay(true)
        this.socket.on('connect', this.onConnect.bind(this));
        this.socket.on('error', this.onError.bind(this));
        this.socket.on('data', this.onData.bind(this));
        this.socket.on('close', this.onClose.bind(this));
        return new Promise((resolve) => {
            this.callbackOnClose = resolve;
        });     // promise resolves when closed by user (not reconnecting)
    }

    onConnect() {
        if (config.verbose === true)
            cprint(`@room ${this.roomid} connected`, colors.green);
        this.socket && this.socket.write(this.handshake);
        this.healthCheck = setInterval(() => {
            if (+new Date() / 1000 - this.lastRead > 35)
                this.close(false);
        }, 45 * 1000);  // 每45秒检查读取状态 如果没读取到任何信息即重连
    }

    onError(error) {
        if (config.verbose === true)
            cprint(`@room ${this.roomid} observed an error: ${error.message}`, colors.red);
    }

    onData(buffer) {
        this.lastRead = +new Date() / 1000;
        this.buffer = Buffer.concat([ this.buffer, buffer ]);
        this.totalLength = this.buffer.readUInt32BE(0);
        if (config.debug === true)
            cprint(`BufferSize ${this.buffer.length} Length ${this.totalLength}`, colors.green);
        while (this.totalLength > 0 && this.buffer.length >= this.totalLength) {
            try {
                this.onMessage(this.buffer.slice(0, this.totalLength));
                this.buffer = this.buffer.slice(this.totalLength, this.buffer.length);
                if (this.buffer.length === 0) {
                    this.totalLength = 0;
                    if (this.buffer.length === 0) {
                        this.buffer = Buffer.alloc(0);
                    }
                } else if (this.buffer.length >= 4) {
                    this.totalLength = this.buffer.readUInt32BE(0);
                }
                if (config.debug === true)
                    cprint(`BufferSize ${this.buffer.length} Length ${this.totalLength}`, colors.green);
            } catch (error) {
                cprint(`Error: ${error.message}`, colors.red);
                cprint('[ 修正 ] TCP连接重启', colors.green);
                this.heartbeatTask && clearInterval(this.heartbeatTask);
                this.heartbeatTask = null;
                this.socket && this.socket.unref().end().destroy();
                this.socket = null;
                this.healthCheck && clearInterval(this.healthCheck);
                this.healthCheck = null;
                return;
            }
        }
    }

    onMessage(buffer) {
        const totalLength = buffer.readUInt32BE(0);
        const headerLength = buffer.readUInt16BE(4);
        const cmd = buffer.readUInt32BE(8);

        let jsonStr = '';
        let msg = null;
        switch (cmd) {
            case 5:
                jsonStr = buffer.toString('utf8', headerLength, totalLength);
                msg = JSON.parse(jsonStr);
                this.processMsg(msg);
                break;
            case 8:
                this.heartbeatTask = setInterval(() => {
                    this.socket && this.socket.write(this.heartbeat);
                }, 30 * 1000);
                break;
        }
    }

    onClose() {
        const color = this.closed_by_user ? colors.green : colors.red;
        if (config.verbose === true)
            cprint(`@room ${this.roomid} lost connection.`, color);
        this.heartbeatTask && clearInterval(this.heartbeatTask);
        this.heartbeatTask = null;
        this.socket && this.socket.unref().end().destroy();
        this.socket = null;
        this.healthCheck && clearInterval(this.healthCheck);
        this.healthCheck = null;
        if (this.closed_by_user === false) {
            this.run();
        } else {
            this.callbackOnClose && this.callbackOnClose(this.roomid);
            this.callbackOnClose = null;
        }
    }

    close(closed_by_us=true) {
        this.closed_by_user = closed_by_us;
        this.heartbeatTask && clearInterval(this.heartbeatTask);
        this.heartbeatTask = null;
        this.socket && this.socket.unref().end().destroy();
        this.socket = null;
        this.healthCheck && clearInterval(this.healthCheck);
        this.healthCheck = null;
    }

    processMsg(msg) {
        if (msg['scene_key'])
            msg = msg['msg'];

        let cmd = msg['cmd'];
        switch (cmd) {
            case 'NOTICE_MSG':
                if (config.verbose === true) 
                    cprint(msg['msg_common'], colors.cyan);
                this.onNoticeMsg(msg);
                break;
            case 'DANMU_MSG':
                break;
            case 'PREPARING':
                this.onPreparing(msg);
                break;
            case 'ROOM_CHANGE':
                this.onRoomChange(msg);
                break;
        }
    }

    onNoticeMsg(msg) {
    }

    onPreparing(msg) {
    }

    onRoomChange(msg) {
    }

    prepareData(cmd, str) {
        const data = StrToUTF8Array(str);
        const headerLength = 16;
        const totalLength = headerLength + data.length;
        
        const buffer = Buffer.alloc(totalLength);
        buffer.writeUInt32BE(totalLength, 0);
        buffer.writeUInt16BE(headerLength, 4);
        buffer.writeUInt16BE(1, 6);
        buffer.writeUInt32BE(cmd, 8);
        buffer.writeUInt32BE(1, 12);

        const len = data.length;
        for (let i = 0; i < len; ++i) {
            buffer.writeUInt8(data[i], 16 + i);
        }

        return buffer;
    }

}

class GuardMonitor extends BilibiliSocket {

    constructor(roomid, uid) {
        super(roomid, uid);
    }

    onNoticeMsg(msg) {

        const msg_type = msg['msg_type'];
        const roomid = msg['real_roomid'];
        
        switch (msg_type) {
            case 3:
                if (roomid === this.roomid) {
                    if (config.verbose === true)
                        cprint(`${this.roomid} - ${msg['msg_common']}`, colors.green);
                    this.emitter && this.emitter.emit('gift', roomid);
                }
                break;
        }
    }

}

class RaffleMonitor extends BilibiliSocket {

    constructor(roomid, uid, areaid=0) {
        super(roomid, uid);
        this.areaid = areaid;
    }

    onNoticeMsg(msg) {

        const msg_type = msg['msg_type'];
        const roomid = msg['real_roomid'];

        
        switch (msg_type) {
            case 2:
                // fall through
            case 6:
                // fall through
            case 8:
                if (config.verbose === true)
                    cprint(`${this.roomid} - ${msg['msg_common']} - ${msg_type}`, colors.green);
                this.emitter && this.emitter.emit('gift', roomid);
                break;
        }
    }

    onPreparing(msg) {
        if (this.areaid !== 0) {
            super.close();
        }
    }

    onRoomChange(msg) {
        const changedInfo = msg['data'];
        const newAreaid = changedInfo['parent_area_id'];
        if (this.areaid !== 0 && this.areaid !== newAreaid) {
            super.close();
        }
    }

}

module.exports = {
    BilibiliSocket, 
    RaffleMonitor, 
    GuardMonitor, 
};