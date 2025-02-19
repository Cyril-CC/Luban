import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { includes } from 'lodash';
import readline from 'linebyline';
import { BatchBufferInfo, CalibrationInfo, CoordinateInfo, CoordinateSystemInfo, ExtruderMovement, ExtruderOffset, FdmToolHeadInfo, GcodeFileInfo, GetHotBed, LaserCalibration, LaserToolHeadInfo, MachineInfo, MachineSize, ModuleInfo, MovementInstruction, PrintBatchGcode, SetLaserPower, WifiConnectionInfo } from 'snapmaker-sacp-sdk/models';
import { Dispatcher, RequestData, ResponseCallback, ResponseData, Response } from 'snapmaker-sacp-sdk';
import net from 'net';
import { stringToBuffer, readString, writeBool, readUint16, readUint32, writeUint16, writeUint8, writeFloat, readFloat, writeInt8, writeInt16, readUint8, writeUint32 } from 'snapmaker-sacp-sdk/helper';
import { PeerId } from 'snapmaker-sacp-sdk/communication/Header';
import { MoveDirection } from 'snapmaker-sacp-sdk/models/MovementInstruction';
import DataStorage from '../../../DataStorage';

export enum CoordinateType {
    MACHINE, WORKSPACE
}

export enum HeadType {
    PRINTING, CNC, LASER
}

export type RequestPhotoInfo = {
    index: number;
    x: number;
    y: number;
    z: number;
    feedRate: number;
    photoQuality: number;
}

export enum ToolHeadType {
    LASER1600mW, LASER10000mW
}

export default class Business extends Dispatcher {
    private log = console;

    public constructor(type: string, socket: net.Socket) {
        super(type, socket);
        this.setHandler(0xb0, 0x00, async (data) => {
            const { nextOffset, result: filename } = readString(data.param, 0);
            const fileLength = readUint32(data.param, nextOffset);
            const chunks = readUint16(data.param, nextOffset + 4);
            const { result: md5HexStr } = readString(data.param, nextOffset + 6);

            this.ack(0xb0, 0x00, data.packet, Buffer.alloc(1, 0));

            console.log('upload file:', filename, fileLength, chunks, md5HexStr);
            // const hash = crypto.createHash('md5');
            const outputStream = fs.createWriteStream(path.join(DataStorage.tmpDir, filename)); // need to rename this filename

            let chunkIndex = 0;
            let receivedLength = 0;
            const md5Buffer = stringToBuffer(md5HexStr);

            const requestPacket = async () => {
                if (chunkIndex <= chunks - 1) {
                    const chunkIndexBuffer = Buffer.alloc(2, 0);
                    writeUint16(chunkIndexBuffer, 0, chunkIndex);
                    const buffer = Buffer.concat([md5Buffer, chunkIndexBuffer]);

                    await this.send(0xb0, 0x01, PeerId.SCREEN, buffer).then((res) => {
                        if (res.response.result === 0) {
                            const { nextOffset: _nextOffset, result: md5HexStr1 } = readString(res.response.data, 0);
                            const chunkIndex1 = readUint16(res.response.data, _nextOffset);
                            const len = readUint16(res.response.data, _nextOffset + 2);
                            receivedLength += len;
                            const chunk = res.response.data.slice(_nextOffset + 2 + 2, _nextOffset + 2 + 2 + len);
                            this.log.debug(`received chunk: ${chunkIndex} success, ${md5HexStr1}, ${chunkIndex1}, ${len}`);
                            outputStream.write(chunk, (err) => {
                                if (err) {
                                    this.log.error(`write chunk error: ${err}`);
                                } else {
                                    // hash.update(chunk);
                                }
                            });
                        } else {
                            this.log.debug(`received chunk: ${chunkIndex} fail`);
                        }
                    });
                    chunkIndex++;
                    await requestPacket();
                }
            };
            await requestPacket();
            outputStream.end();
            let resultBuffer = Buffer.alloc(1, 0);
            const filenameBuffer = stringToBuffer(filename);
            if (fileLength !== receivedLength) {
                resultBuffer = Buffer.alloc(1, 1);
            }
            this.send(0xb0, 0x02, PeerId.SCREEN, Buffer.concat([resultBuffer, filenameBuffer, md5Buffer]));
        });
    }

    public setLogger(log: any) {
        this.log = log;
    }

    public async updateCoordinate(coordinateType: CoordinateType) {
        return this.send(0x01, 0x31, PeerId.CONTROLLER, Buffer.alloc(1, coordinateType)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async executeGcode(gcode: string) {
        return this.send(0x01, 0x02, PeerId.CONTROLLER, stringToBuffer(gcode)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async logFeedbackLevel(level = 2) {
        return this.send(0x01, 0x10, PeerId.CONTROLLER, Buffer.alloc(1, level)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async subscribeLogFeedback({ interval = 3600000 }, callback: ResponseCallback) {
        return this.subscribe(0x01, 0xa1, interval, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async unSubscribeLogFeedback(callback: ResponseCallback) {
        return this.unsubscribe(0x01, 0xa1, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async getEmergencyStopInfo() {
        return this.send(0x01, 0x3b, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            // const isTouch = readBool(response.data);
            // console.log('emergencyResponse', response);
            return { packet, data: response };
        });
    }

    public async takePhoto({ index = 0, x = 0, y = 0, z = 0, feedRate = 0, photoQuality = 0 }: RequestPhotoInfo) {
        const buffer = Buffer.alloc(16, 0);
        let nextOffset = 0;
        nextOffset = writeUint8(buffer, nextOffset, index);
        nextOffset = writeFloat(buffer, nextOffset, x);
        nextOffset = writeFloat(buffer, nextOffset, y);
        nextOffset = writeFloat(buffer, nextOffset, z);
        nextOffset = writeUint16(buffer, nextOffset, feedRate);
        writeUint8(buffer, nextOffset, photoQuality);
        return this.send(0xb0, 0x04, PeerId.SCREEN, buffer);
    }

    public async getCameraCalibration(toolHeadType: ToolHeadType = ToolHeadType.LASER1600mW) {
        return this.send(0xb0, 0x03, PeerId.SCREEN, Buffer.alloc(1, toolHeadType)).then(({ response, packet }) => {
            let calibrationInfo = null;
            if (response.result === 0) {
                calibrationInfo = new CalibrationInfo().fromBuffer(response.data);
            }
            return { response, packet, calibrationInfo };
        });
    }

    public async getPhoto(index = 0) {
        return this.send(0xb0, 0x05, PeerId.SCREEN, Buffer.alloc(1, index)).then(({ response, packet }) => {
            const data = {
                filename: '',
                md5Str: ''
            };
            if (response.result === 0) {
                const { nextOffset, result } = readString(response.data);
                data.filename = result;
                const res = readString(response.data, nextOffset);
                data.md5Str = res.result;
            }
            return { response, packet, data };
        });
    }

    public async getCalibrationPhoto(toolHeadType: ToolHeadType = ToolHeadType.LASER1600mW) {
        return this.send(0xb0, 0x06, PeerId.SCREEN, Buffer.alloc(1, toolHeadType)).then(({ response, packet }) => {
            const data = {
                filename: '',
                md5Str: ''
            };
            if (response.result === 0) {
                const { nextOffset, result } = readString(response.data);
                data.filename = result;
                const res = readString(response.data, nextOffset);
                data.md5Str = res.result;
            }
            return { response, packet, data };
        });
    }

    public async setMatrix(toolHeadType: ToolHeadType = ToolHeadType.LASER1600mW, matrix: CalibrationInfo) {
        const calibrationInfo = new CalibrationInfo(matrix.points, matrix.corners);
        return this.send(0xb0, 0x07, PeerId.SCREEN, Buffer.concat([Buffer.alloc(1, toolHeadType), calibrationInfo.toBuffer()]));
    }

    public async startScreenPrint({ headType = HeadType.PRINTING, filename = '', hash = '' }) {
        const filenameBuffer = stringToBuffer(filename);
        const hashBuffer = stringToBuffer(hash);
        return this.send(0xb0, 0x08, PeerId.SCREEN, Buffer.concat([Buffer.alloc(1, headType), filenameBuffer, hashBuffer])).then(res => {
            return res;
        });
    }

    public async getLaserMaterialThickness({ token = '', x = 0, y = 0, feedRate = 0 }) {
        // const tokenBuffer = stringToBuffer(token);
        const buffer = Buffer.alloc(10, 0);
        let nextOffset = 0;
        nextOffset = writeFloat(buffer, nextOffset, x);
        nextOffset = writeFloat(buffer, nextOffset, y);
        writeUint16(buffer, nextOffset, feedRate);
        return this.send(0xb0, 0x09, PeerId.SCREEN, Buffer.concat([buffer])).then(({ response, packet }) => {
            let thickness = 0;
            if (response.result === 0) {
                thickness = readFloat(response.data);
            }
            return { response, packet, thickness };
        });
    }

    public async setWorkOrigin(coordinateInfos: Array<CoordinateInfo>) {
        let buffer = Buffer.alloc(0);
        const lenBuffer = Buffer.alloc(1, 0);
        writeUint8(lenBuffer, 0, coordinateInfos.length);
        buffer = Buffer.concat([buffer, lenBuffer]);

        coordinateInfos.forEach(item => {
            const m = new CoordinateInfo(item.key, item.value).toBuffer();
            console.log('buffer', m);
            buffer = Buffer.concat([buffer, m]);
        });
        return this.send(0x01, 0x32, PeerId.CONTROLLER, buffer);
    }

    public async moveAbsolutely(movementInstructions: Array<MovementInstruction>, speed = 0) {
        const speedBuffer = Buffer.alloc(2, 0);
        writeUint16(speedBuffer, 0, speed);
        let buffer = Buffer.alloc(0);

        const lenBuffer = Buffer.alloc(1, 0);
        writeUint8(lenBuffer, 0, movementInstructions.length);
        buffer = Buffer.concat([buffer, lenBuffer]);

        movementInstructions.forEach(item => {
            const m = new MovementInstruction(item.direction, item.distance).toBuffer();
            buffer = Buffer.concat([buffer, m]);
        });
        return this.send(0x01, 0x34, PeerId.CONTROLLER, Buffer.concat([buffer, speedBuffer]));
    }

    public async getLaserToolHeadInfo(key: number) {
        const buffer = Buffer.alloc(1, 0);
        writeUint8(buffer, 0, key);
        return this.send(0x12, 0x01, PeerId.CONTROLLER, buffer).then(({ response }) => {
            let laserToolHeadInfo = new LaserToolHeadInfo();
            if (response.result === 0) {
                laserToolHeadInfo = laserToolHeadInfo.fromBuffer(response.data);
            }
            return { response, laserToolHeadInfo };
        });
    }

    // ----------

    public async subscribeHeartbeat({ interval = 1000 }, callback: ResponseCallback) {
        return this.subscribe(0x01, 0xa0, interval, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async unsubscribeHeartbeat(callback: ResponseCallback) {
        return this.unsubscribe(0x01, 0xa0, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async getModuleInfo() {
        return this.send(0x01, 0x20, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            const moduleInfos = ModuleInfo.parseArray(response.data) as ModuleInfo[];
            return { code: response.result, packet, data: moduleInfos as ModuleInfo[] };
        });
    }

    public async getMachineInfo() {
        return this.send(0x01, 0x21, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            const machineInfo = new MachineInfo().fromBuffer(response.data);
            return { code: response.result, packet, data: machineInfo as MachineInfo };
        });
    }

    // unimplemented by master control
    public async getMachineSize() {
        return this.send(0x01, 0x22, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            const machineSize = new MachineSize().fromBuffer(response.data);
            return { response, packet, data: { machineSize }, machineSize };
        });
    }

    public async getCurrentCoordinateInfo() {
        return this.send(0x01, 0x30, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            const coordinateSystemInfo = new CoordinateSystemInfo().fromBuffer(response.data);
            return { response, packet, data: { coordinateSystemInfo }, coordinateSystemInfo };
        });
    }

    public async subscribeCurrentCoordinateInfo({ interval = 1000 }, callback: ResponseCallback) {
        return this.subscribe(0x01, 0xa2, interval, callback).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async unSubscribeCurrentCoordinateInfo(callback: ResponseCallback) {
        return this.unsubscribe(0x01, 0xa2, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async movementInstruction(direction: MoveDirection, distance: number, speed: number) {
        const info = new MovementInstruction(direction, distance, speed);
        return this.send(0x01, 0x34, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async requestHome(number = 0) {
        return this.send(0x01, 0x35, PeerId.CONTROLLER, Buffer.alloc(1, number)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async requestAbsoluteCooridateMove(directions: MoveDirection[] = [0], distances: number[] = [0], jogSpeed = 0.1, coordinateType: CoordinateType) {
        const paramBuffer = new MovementInstruction(undefined, undefined, jogSpeed, directions, distances, coordinateType).toArrayBuffer();
        return this.send(0x01, 0x34, PeerId.CONTROLLER, paramBuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async startPrint(md5: string, gcodeName: string, headType: number) {
        const info = new GcodeFileInfo(md5, gcodeName, headType);
        return this.send(0xac, 0x03, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async stopPrint() {
        return this.send(0xac, 0x06, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async pausePrint() {
        return this.send(0xac, 0x04, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async resumePrint() {
        return this.send(0xac, 0x05, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async getGocdeFile() {
        return this.send(0xac, 0x00, PeerId.CONTROLLER, Buffer.alloc(0)).then(({ response, packet }) => {
            const gcodeFileInfo = new GcodeFileInfo().fromBuffer(response.data);
            return { response, packet, data: { gcodeFileInfo } };
        });
    }

    public async laserCalibration(calibrationMode: number) {
        const info = new LaserCalibration(calibrationMode);
        return this.send(0xa8, 0x02, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async laserCalibrationSave(type: number) {
        return this.send(0xa8, 0x03, PeerId.CONTROLLER, Buffer.alloc(1, type)).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetLaserPower(key: number, power: number) {
        const info = new SetLaserPower(key, power);
        return this.send(0x12, 0x02, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetBrightness(key: number, brightness: number) {
        const tobuffer = Buffer.alloc(1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, brightness);
        return this.send(0x12, 0x03, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetFocalLength(key: number, focalLength: number) {
        const tobuffer = Buffer.alloc(1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, focalLength);
        return this.send(0x12, 0x04, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async TemperatureProtect(key: number, protectTemperature: number, recoverTemperature: number) {
        const tobuffer = Buffer.alloc(1 + 1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, protectTemperature);
        writeInt8(tobuffer, 2, recoverTemperature);
        return this.send(0x12, 0x05, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }


    public async SetLaserLock(key: number, lockStatus: number) {
        const tobuffer = Buffer.alloc(1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, lockStatus);
        return this.send(0x12, 0x07, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async GetFDMInfo(key: number) {
        const info = new FdmToolHeadInfo(key);
        return this.send(0x10, 0x01, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            // console.log('FDMSubCase',info.toBuffer,response,packet)
            const getFDMInfo = new FdmToolHeadInfo().fromBuffer(response.data);
            return { response, packet, data: { getFDMInfo } };
        });
    }

    public async subscribeNozzleInfo({ interval = 1000 }, callback: ResponseCallback) {
        return this.subscribe(0x10, 0xa0, interval, callback).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async unSubscribeNozzleInfo(callback: ResponseCallback) {
        return this.unsubscribe(0x10, 0xa0, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async GetHotBed(key: number) {
        const info = new GetHotBed(key);
        return this.send(0x14, 0x01, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            const hotBedInfo = new GetHotBed().fromBuffer(response.data);
            return { response, packet, data: { hotBedInfo } };
        });
    }

    public async subscribeHotBedTemperature({ interval = 1000 }, callback: ResponseCallback) {
        return this.subscribe(0x14, 0xa0, interval, callback).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async unSubscribeHotBedTemperature(callback: ResponseCallback) {
        return this.unsubscribe(0x14, 0xa0, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async subscribeWorkSpeed({ interval = 1000 }, callback: ResponseCallback) {
        this.log.info('subscribeWorkSpeed');
        return this.subscribe(0xac, 0xa4, interval, callback).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async unSubscribeWorkSpeed(callback: ResponseCallback) {
        return this.unsubscribe(0xac, 0xa4, callback).then(({ response, packet }) => {
            return { code: response.result, packet, data: {} };
        });
    }

    public async SetExtruderTemperature(key: number, extruderIndex: number, temperature: number) {
        const tobuffer = Buffer.alloc(1 + 1 + 2, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, extruderIndex);
        writeInt16(tobuffer, 2, temperature);
        return this.send(0x10, 0x02, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetFilamentstatus(key: number, extruderIndex: number, filamentstatus: number) {
        const tobuffer = Buffer.alloc(1 + 1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, extruderIndex);
        writeUint8(tobuffer, 2, filamentstatus);
        return this.send(0x10, 0x04, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SwitchExtruder(key: number, extruderIndex: number) {
        const tobuffer = Buffer.alloc(1 + 1, 0);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, extruderIndex);
        return this.send(0x10, 0x05, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetExtruderSpeed(key: number, fansIndex: number, speedLevel: number) {
        const tobuffer = Buffer.alloc(1 + 1 + 1);
        writeUint8(tobuffer, 0, key);
        writeUint8(tobuffer, 1, fansIndex);
        writeUint8(tobuffer, 2, speedLevel);
        return this.send(0x10, 0x06, PeerId.CONTROLLER, tobuffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async SetExtruderOffset(key: number, index: number, distance: number) {
        const info = new ExtruderOffset(key, index, distance);
        return this.send(0xa0, 0x15, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async GetExtruderOffset(key: number) {
        return this.send(0x10, 0x08, PeerId.CONTROLLER, Buffer.alloc(1, key)).then(({ response, packet }) => {
            const ExtruderOffsetInfo = new ExtruderOffset().fromBuffer(response.data);
            return { response, packet, data: { ExtruderOffsetInfo } };
        });
    }

    public async ExtruderMovement(key: number, movementType: number, lengthIn: number, speedIn: number, lengthOut: number, speedOut: number) {
        const info = new ExtruderMovement(key, movementType, lengthIn, speedIn, lengthOut, speedOut);
        return this.send(0x10, 0x09, PeerId.CONTROLLER, info.toBuffer()).then(({ response, packet }) => {
            return { response, packet };
        });
    }

    public async uploadFile(filePath: string) {
        const sizePerChunk = 60 * 1024;
        this.setHandler(0xb0, 0x01, (data) => {
            const { nextOffset, result: md5HexStr } = readString(data.param);
            // console.log('>>', md5HexStr, nextOffset);
            const index = readUint16(data.param, nextOffset);
            // console.log('>>', index);
            this.log.info(`receive file chunk request: md5: ${md5HexStr}, index: ${index}`);

            const inputStream = fs.createReadStream(filePath, {
                start: index * sizePerChunk, end: (index + 1) * sizePerChunk - 1, highWaterMark: sizePerChunk
            });
            let buffer = Buffer.alloc(1, 200); // result = 1, means file EOF reached
            let finalBuf = Buffer.alloc(0);
            inputStream.on('data', (buf: Buffer) => {
                // console.log('>-', buf);
                finalBuf = Buffer.concat([finalBuf, buf]);
            });
            inputStream.on('end', () => {
                // console.log('>-', finalBuf.byteLength);
                const md5Buffer = stringToBuffer(md5HexStr);
                const indexBuffer = Buffer.alloc(2, 0);
                writeUint16(indexBuffer, 0, index);
                // const chunkLengthBuffer = Buffer.alloc(2, 0);
                // writeUint16(chunkLengthBuffer, 0, finalBuf.byteLength);
                // const chunkBuffer = Buffer.concat([chunkLengthBuffer, finalBuf]); //stringToBuffer(finalBuf.toString());
                const chunkBuffer = stringToBuffer(finalBuf as unknown as string);

                buffer = Buffer.concat([Buffer.alloc(1, 0), md5Buffer, indexBuffer, chunkBuffer]);
                // console.log('>--', buffer);
                this.ack(0xb0, 0x01, data.packet, buffer);
            });
            inputStream.once('error', () => {
                this.ack(0xb0, 0x01, data.packet, buffer);
            });
        });

        return new Promise<ResponseData>((resolve, reject) => {
            // handle file upload result
            this.setHandler(0xb0, 0x02, (data) => {
                if (readUint8(data.param) === 0) {
                    this.log.info('file upload success');
                } else {
                    this.log.error('file upload fail');
                }
                this.ack(0xb0, 0x02, data.packet, Buffer.alloc(1, 0));
                resolve({
                    response: {
                        result: 0,
                        data: Buffer.alloc(0)
                    }
                } as any);
            });

            if (fs.existsSync(filePath)) {
                const hash = crypto.createHash('md5');
                const inputStream = fs.createReadStream(filePath);
                inputStream.on('data', (data) => {
                    hash.update(data);
                });
                inputStream.on('end', () => {
                    const md5HexStr = hash.digest('hex');
                    const filename = path.basename(filePath);
                    const fileLength = fs.statSync(filePath).size;
                    const chunks = Math.ceil(fileLength / sizePerChunk);

                    const filenameBuffer = stringToBuffer(filename);
                    const fileLengthBuffer = Buffer.alloc(4, 0);
                    writeUint32(fileLengthBuffer, 0, fileLength);
                    const md5Buffer = stringToBuffer(md5HexStr);
                    const chunksBuffer = Buffer.alloc(2, 0);
                    writeUint16(chunksBuffer, 0, chunks);

                    const buffer = Buffer.concat([filenameBuffer, fileLengthBuffer, chunksBuffer, md5Buffer]);
                    this.send(0xb0, 0x00, PeerId.SCREEN, buffer).catch(err => {
                        reject(err);
                    });
                });
            } else {
                reject(new Error(`can not upload missing file: ${filePath}`));
            }
        });
    }

    public startPrintSerial(filePath: string, callback: any) {
        const content: string[] = [];
        let elapsedTime = 0;
        const rl = readline(filePath);
        rl.on('line', (line: string) => {
            line[0] !== ';' && content.push(`${line}\n`);
            if (includes(line, ';estimated_time(s)')) {
                elapsedTime = parseFloat(line.slice(19));
            }
        }).on('error', (e: any) => {
            console.log('e', e);
        });
        this.setHandler(0xac, 0x02, async ({ param, packet }: RequestData) => {
            const batchBufferInfo = new BatchBufferInfo().fromBuffer(param);
            // const content = await readGcodeFileByLines(filePath);
            let result = 0;
            const printBatchGcode = new PrintBatchGcode(batchBufferInfo.lineNumber, batchBufferInfo.lineNumber, content[batchBufferInfo.lineNumber]);
            if (batchBufferInfo.lineNumber === content.length - 1) {
                result = 201;
            }
            const res = new Response(result, printBatchGcode.toBuffer());
            this.ack(0xac, 0x02, packet, res.toBuffer());
            callback && callback({ lineNumber: batchBufferInfo.lineNumber, length: content.length, elapsedTime });
        });
        this.setHandler(0xac, 0x01, (request: RequestData) => {
            console.log({ request });
        });
    }

    // TODO
    public async setHotBedTemperature(key: number, zoneIndex: number, temperature: number) {
        const buffer = Buffer.alloc(4, 0);
        writeUint8(buffer, 0, key);
        writeUint8(buffer, 1, zoneIndex);
        writeInt16(buffer, 2, temperature);
        return this.send(0x14, 0x02, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            // const hotBedInfo = new GetHotBed().fromBuffer(response.data);
            return { response, packet, data: { } };
        });
    }

    public async subscribeCncSpeedState({ interval = 1000 }, callback: ResponseCallback) {
        return this.subscribe(0x11, 0xa0, interval, callback).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async setCncPower(key: number, targetPower:number) {
        const buffer = Buffer.alloc(2, 0);
        writeUint8(buffer, 0, key);
        writeUint8(buffer, 1, targetPower);
        return this.send(0x11, 0x02, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async setToolHeadSpeed(key: number, targetSpeed:number) {
        const buffer = Buffer.alloc(5, 0);
        writeUint8(buffer, 0, key);
        writeUint32(buffer, 1, targetSpeed);
        return this.send(0x11, 0x03, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async switchCNC(key:number, status: boolean) {
        const buffer = Buffer.alloc(2, 0);
        writeUint8(buffer, 0, key);
        writeBool(buffer, 1, status ? 1 : 0);
        return this.send(0x11, 0x05, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }


    public async setWorkSpeed(key: number, extruderIndex: number, targetSpeed:number) {
        const buffer = Buffer.alloc(4, 0);
        writeUint8(buffer, 0, key);
        writeUint8(buffer, 1, extruderIndex);
        writeInt16(buffer, 2, targetSpeed);
        return this.send(0xac, 0x0e, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            return { response, packet, data: {} };
        });
    }

    public async getWorkSpeed(key: number) {
        const buffer = Buffer.alloc(1, 0);
        writeUint8(buffer, 0, key);
        return this.send(0xac, 0x0f, PeerId.CONTROLLER, buffer).then(({ response, packet }) => {
            return { response, packet, data: { } };
        });
    }

    public async wifiConnection(hostName: string, clientName: string, token: string, callback: any) {
        const info = new WifiConnectionInfo(hostName, clientName, token).toBuffer();
        this.setHandler(0x01, 0x06, ({ param, packet }: RequestData) => {
            const res = new Response(0);
            this.ack(0x01, 0x06, packet, res.toBuffer());
            callback && callback();
        });
        return this.send(0x01, 0x05, PeerId.SCREEN, info).then(({ response, packet }) => {
            // return res;
            return { response, packet };
        });
    }

    public async wifiConnectionClose() {
        return this.send(0x01, 0x06, PeerId.SCREEN, Buffer.alloc(0)).then(({ response, packet }) => {
            log.info('close response');
            return { response, packet };
        });
    }
}
