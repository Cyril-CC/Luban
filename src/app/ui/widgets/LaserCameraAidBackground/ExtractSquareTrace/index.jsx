import React, { PureComponent } from 'react';
import { connect } from 'react-redux';
import classNames from 'classnames';
import PropTypes from 'prop-types';
import { Spin } from 'antd';
import i18n from '../../../../lib/i18n';
import api from '../../../../api';
import styles from '../styles.styl';
import ExtractPreview from './ExtractPreview';
import ManualCalibration from '../ManualCalibration';
import { LEVEL_ONE_POWER_LASER_FOR_SM2, LEVEL_TWO_POWER_LASER_FOR_SM2,
    MACHINE_SERIES, LASER_10W_TAKE_PHOTO_POSITION, getCurrentHeadType } from '../../../../constants';
import { actions } from '../../../../flux/machine';
import { Button } from '../../../components/Buttons';
import Modal from '../../../components/Modal';

const PANEL_EXTRACT_TRACE = 1;
const PANEL_MANUAL_CALIBRATION = 2;
const DefaultBgiName = '../../../../resources/images/camera-aid/Loading.gif';

class ExtractSquareTrace extends PureComponent {
    static propTypes = {
        laserSize: PropTypes.object.isRequired,
        size: PropTypes.object.isRequired,
        server: PropTypes.object.isRequired,
        series: PropTypes.string.isRequired,
        toolHead: PropTypes.object.isRequired,
        headType: PropTypes.string,
        canTakePhoto: PropTypes.bool.isRequired,
        lastFileNames: PropTypes.array,
        xSize: PropTypes.array.isRequired,
        ySize: PropTypes.array.isRequired,
        updateEachPicSize: PropTypes.func.isRequired,
        changeLastFileNames: PropTypes.func.isRequired,
        changeCanTakePhoto: PropTypes.func.isRequired,
        setBackgroundImage: PropTypes.func.isRequired,
        hideModal: PropTypes.func.isRequired,
        executeGcodeG54: PropTypes.func.isRequired
    };

    extractingPreview = [];

    close = false;

    multiple = 2;

    state = {
        loading: false, // loading when 10w laser taking photo
        panel: PANEL_EXTRACT_TRACE,
        getPhotoTasks: [],
        imageNames: [],
        manualPoints: [],
        matrix: '',
        xSize: this.props.xSize,
        ySize: this.props.ySize,
        shouldCalibrate: false,
        isStitched: false,
        canStart: true,
        outputFilename: '',
        options: {
            picAmount: 1,
            currentIndex: 0,
            size: this.props.size,
            series: this.props.series,
            centerDis: 100,
            currentArrIndex: 0,
            getPoints: [],
            corners: [],
            fileNames: [],
            stitchFileName: ''
        }
    };


    actions = {
        backtoCalibrationModal: () => {
            this.setState({
                panel: PANEL_EXTRACT_TRACE
            });
        },
        updateAffinePoints: (manualPoints) => {
            this.setState({
                manualPoints
            });
        },
        displayExtractTrace: () => {
            this.setState({ panel: PANEL_EXTRACT_TRACE });
        },
        calibrationOnOff: (shouldCalibrate) => {
            this.setState({
                shouldCalibrate
            });
        },
        startCameraAid: async () => {
            if (!this.props.canTakePhoto) {
                return;
            }
            await this.props.server.executeGcode('G53;');

            this.setState({
                isStitched: false,
                canStart: false
            });
            this.props.changeCanTakePhoto(false);
            const { address } = this.props.server;
            const resPro = await api.getCameraCalibration({ 'address': address, 'toolHead': this.props.toolHead.laserToolhead });
            const resData = JSON.parse(resPro.body.res.text);

            this.setState({
                options: {
                    ...this.state.options,
                    corners: resData.corners,
                    getPoints: resData.points
                }
            });
            const position = [];
            let centerDis;
            let cameraOffsetX = 20;
            let cameraOffsetY = -8.5;
            let length;
            if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                cameraOffsetX = 20;
                cameraOffsetY = -8.5;
                if (this.props.series === MACHINE_SERIES.A150.value) {
                    centerDis = 80;
                    [1, 2, 4, 3].forEach((item) => {
                        position.push({
                            'x': this.props.laserSize.x / 2 + cameraOffsetX + centerDis / 2 * (item % 2 === 1 ? -1 : 1),
                            'y': this.props.laserSize.y / 2 + cameraOffsetY + centerDis / 2 * (Math.ceil(item / 2) === 1 ? 1 : -1),
                            'index': item - 1
                        });
                    });
                    length = 4;
                } else {
                    if (this.props.series === MACHINE_SERIES.A250.value) {
                        centerDis = 90;
                    } else if (this.props.series === MACHINE_SERIES.A350.value) {
                        centerDis = 106;
                    } else {
                        centerDis = 110;
                    }
                    for (let j = 1; j >= -1; j--) {
                        if (j === 1 || j === -1) {
                            for (let i = -1; i <= 1; i++) {
                                const x = this.props.laserSize.x / 2 + cameraOffsetX + centerDis * i;
                                const y = this.props.laserSize.y / 2 + cameraOffsetY + centerDis * j;
                                position.push({ 'x': x, 'y': y, 'index': position.length });
                            }
                        } else if (j === 0) {
                            for (let i = 1; i >= -1; i--) {
                                const x = this.props.laserSize.x / 2 + cameraOffsetX + centerDis * i;
                                const y = this.props.laserSize.y / 2 + cameraOffsetY + centerDis * j;
                                if (position.length === 3) {
                                    position.push({ 'x': x, 'y': y, 'index': 5 });
                                } else if (position.length === 5) {
                                    position.push({ 'x': x, 'y': y, 'index': 3 });
                                } else {
                                    position.push({ 'x': x, 'y': y, 'index': position.length });
                                }
                            }
                        }
                    }
                    length = 9;
                }
            } else if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                // TODO
                this.setState({
                    loading: true
                });
                cameraOffsetX = 60;
                cameraOffsetY = 0;
                position.push({
                    'index': 0,
                    'x': this.props.laserSize.x / 2 + cameraOffsetX,
                    'y': this.props.laserSize.y / 2 + cameraOffsetY
                });
                length = 1;
            }

            this.setState({
                options: {
                    ...this.state.options,
                    centerDis,
                    currentIndex: 0,
                    currentArrIndex: 0
                }
            });
            const takePhotos = this.actions.takePhotos(address, position);
            const getPhototTasks = this.actions.startGetPhotoTasks(length);
            Promise.all([takePhotos, getPhototTasks]).then(() => {
                if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                    if (this.props.series !== MACHINE_SERIES.A150.value) {
                        this.swapItem(this.state.imageNames, 3, 5);
                    } else {
                        this.swapItem(this.state.imageNames, 2, 3);
                    }
                }
                this.setState({
                    options: {
                        ...this.state.options,
                        fileNames: this.state.imageNames
                    }
                });
                this.props.changeLastFileNames(this.state.imageNames);
                this.props.updateEachPicSize('xSize', this.state.xSize);
                this.props.updateEachPicSize('ySize', this.state.ySize);

                if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                    this.actions.processStitch(this.state.options);
                } else if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                    this.setState({
                        isStitched: true
                    });
                }
                this.props.changeCanTakePhoto(true);
            });
        },

        takePhotos: (address, position) => {
            const getPhotoTasks = this.state.getPhotoTasks;
            let z, photoQuality;
            if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                z = 170;
                if (this.state.options.picAmount === 4) {
                    z = 140;
                }
                photoQuality = 31;
            }
            if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                const defaultPos = LASER_10W_TAKE_PHOTO_POSITION[this.props.series];
                z = defaultPos.z;
                position[0].x = defaultPos.x;
                position[0].y = defaultPos.y;
                photoQuality = 10;
            }
            return new Promise(async (resolve, reject) => {
                for (let i = 0; i < position.length; i++) {
                    if (this.close) {
                        this.props.changeCanTakePhoto(true);
                        this.props.executeGcodeG54(this.props.series, this.props.headType);
                        reject();
                        return;
                    }
                    await api.processTakePhoto({
                        'index': position[i].index,
                        'x': position[i].x,
                        'y': position[i].y,
                        'z': z,
                        'feedRate': 3000,
                        'address': address,
                        'photoQuality': photoQuality
                    });
                    getPhotoTasks.push({
                        address: address,
                        index: position[i].index,
                        status: 0
                    });
                }
                resolve();
            });
        },

        startGetPhotoTasks: (length) => {
            if (this.timer) {
                return Promise.reject();
            }
            const getPhotoTasks = this.state.getPhotoTasks;
            return new Promise(((resolve, reject) => {
                this.timer = setInterval(() => {
                    if (this.close) {
                        this.timer && clearInterval(this.timer);
                        this.timer = null;
                        reject();
                    }
                    const success = getPhotoTasks.filter(v => v.status === 2).length;
                    if (success === length) {
                        this.timer && clearInterval(this.timer);
                        this.timer = null;
                        resolve();
                    }
                    const post = getPhotoTasks.filter(v => v.status === 1).length;
                    if (post === 1) {
                        return;
                    }
                    const task = getPhotoTasks.find(v => v.status === 0);
                    if (!task) {
                        return;
                    }
                    task.status = 1;
                    api
                        .processGetPhoto({ 'index': task.index, 'address': task.address })
                        .then((res) => {
                            if (JSON.parse(res.text).fileName || JSON.parse(res.text).status !== 404) {
                                if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                                    if (this.props.series === MACHINE_SERIES.A150.value) {
                                        this.state.xSize[task.index] = this.props.laserSize.x / 2;
                                        this.state.ySize[task.index] = this.props.laserSize.y / 2;
                                    } else {
                                        if (parseInt(task.index / 3, 10) === 1) {
                                            this.state.ySize[task.index] = this.state.options.centerDis;
                                        } else {
                                            this.state.ySize[task.index] = ((this.props.laserSize.y - this.state.options.centerDis) / 2);
                                        }
                                        if (task.index % 3 === 1) {
                                            this.state.xSize[task.index] = this.state.options.centerDis;
                                        } else {
                                            this.state.xSize[task.index] = ((this.props.laserSize.x - this.state.options.centerDis) / 2);
                                        }
                                    }
                                } else if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                                    this.state.xSize[task.index] = this.props.laserSize.x;
                                    this.state.ySize[task.index] = this.props.laserSize.y;
                                }
                                this.props.updateEachPicSize('xSize', this.state.xSize);
                                this.props.updateEachPicSize('ySize', this.state.ySize);

                                if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                                    this.extractingPreview[task.index].current.onChangeImage(
                                        DefaultBgiName,
                                        this.state.xSize[task.index] * this.multiple * 0.85,
                                        this.state.ySize[task.index] * this.multiple * 0.85,
                                        task.index,
                                        this.multiple
                                    );

                                    const { fileName } = JSON.parse(res.text);
                                    this.setState({
                                        options: {
                                            ...this.state.options,
                                            currentIndex: task.index,
                                            stitchFileName: fileName
                                        }
                                    });
                                    this.state.imageNames.push(fileName);
                                    api.processStitchEach(this.state.options).then((stitchImg) => {
                                        const { filename } = JSON.parse(stitchImg.text);
                                        if (this.extractingPreview[task.index].current) {
                                            this.extractingPreview[task.index].current.onChangeImage(
                                                filename,
                                                this.state.xSize[task.index] * this.multiple * 0.85,
                                                this.state.ySize[task.index] * this.multiple * 0.85,
                                                task.index,
                                                this.multiple
                                            );
                                        }
                                        task.status = 2;
                                    });
                                } else if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                                    const { fileName } = JSON.parse(res.text);
                                    this.setState({
                                        options: {
                                            ...this.state.options,
                                            currentIndex: task.index,
                                            stitchFileName: fileName
                                        }
                                    });
                                    this.extractingPreview[task.index].current.onChangeImage(
                                        fileName,
                                        this.state.xSize[task.index] * this.multiple * 0.85,
                                        this.state.ySize[task.index] * this.multiple * 0.85,
                                        task.index,
                                        this.multiple
                                    );
                                    api.processStitchEach(this.state.options).then((stitchImg) => {
                                        const { filename } = JSON.parse(stitchImg.text);
                                        if (this.extractingPreview[task.index].current) {
                                            this.extractingPreview[task.index].current.onChangeImage(
                                                filename,
                                                this.state.xSize[task.index] * this.multiple * 0.85,
                                                this.state.ySize[task.index] * this.multiple * 0.85,
                                                task.index,
                                                this.multiple
                                            );
                                        }
                                        this.setState({
                                            outputFilename: filename,
                                            loading: false
                                        });
                                        task.status = 2;
                                    });
                                }
                            } else {
                                task.status = 0;
                            }
                        })
                        .catch(() => {
                            this.close = true;
                        });
                }, 500);
            }));
        },
        updateStitchEach: async () => {
            if (this.props.series === MACHINE_SERIES.A350.value) {
                this.multiple = 1.5;
            } else if (this.props.series === MACHINE_SERIES.A150.value) {
                this.setState({
                    options: {
                        ...this.state.options,
                        centerDis: 80
                    }
                });
            }
            if (this.state.shouldCalibrate && this.state.manualPoints.length === 4) {
                this.setState({
                    options: {
                        ...this.state.options,
                        getPoints: this.state.manualPoints
                    }
                });
            } else {
                const resPro = await api.getCameraCalibration({ 'address': this.props.server.address, 'toolHead': this.props.toolHead.laserToolhead });
                const resData = JSON.parse(resPro.body.res.text);
                this.setState({
                    options: {
                        ...this.state.options,
                        getPoints: resData.points,
                        corners: resData.corners
                    }
                });
            }
            // fileNames, getPoints, corners, size, centerDis
            for (let i = 0; i < this.props.lastFileNames.length; i++) {
                if (this.state.xSize.length > 0 && this.state.ySize.length > 0) {
                    this.extractingPreview[i].current.onChangeImage(
                        DefaultBgiName, this.state.xSize[i] * this.multiple * 0.85, this.state.ySize[i] * this.multiple * 0.85, i, this.multiple
                    );
                } else {
                    this.extractingPreview[i].current.onChangeImage(
                        DefaultBgiName, this.props.xSize[i] * this.multiple * 0.85, this.props.ySize[i] * this.multiple * 0.85, i, this.multiple
                    );
                }
                const stitchImg = await api.processStitchEach(
                    {
                        ...this.state.options,
                        currentIndex: i,
                        stitchFileName: this.props.lastFileNames[i]
                    }
                );
                const { filename } = JSON.parse(stitchImg.text);

                if (this.state.xSize.length > 0 && this.state.ySize.length > 0) {
                    this.extractingPreview[i].current.onChangeImage(
                        filename, this.state.xSize[i] * this.multiple * 0.85, this.state.ySize[i] * this.multiple * 0.85, i, this.multiple
                    );
                } else {
                    this.extractingPreview[i].current.onChangeImage(
                        filename, this.props.xSize[i] * this.multiple * 0.85, this.props.ySize[i] * this.multiple * 0.85, i, this.multiple
                    );
                }
            }

            if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
                api.processStitch({
                    ...this.state.options,
                    fileNames: this.props.lastFileNames
                }).then((res) => {
                    this.setState({
                        outputFilename: res.body.filename,
                        isStitched: true
                    });
                });
            } else if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
                api.processStitchEach(this.state.options).then((stitchImg) => {
                    const { filename } = JSON.parse(stitchImg.text);
                    if (this.extractingPreview[0].current) {
                        this.extractingPreview[0].current.onChangeImage(
                            filename,
                            this.state.xSize[0] * this.multiple * 0.85,
                            this.state.ySize[0] * this.multiple * 0.85,
                            0,
                            this.multiple
                        );
                    }
                    this.setState({
                        outputFilename: filename,
                        isStitched: true
                    });
                });
            }
            this.props.changeCanTakePhoto(true);
        },

        processStitch: (options) => {
            api.processStitch(options).then((res) => {
                this.setState({
                    outputFilename: res.body.filename,
                    isStitched: true
                });
                this.props.executeGcodeG54(this.props.series, this.props.headType);
            });
        },
        setBackgroundImage: () => {
            this.props.setBackgroundImage(this.state.outputFilename);
        },
        displayManualCalibration: async () => {
            const resPro = await api.getCameraCalibration({ 'address': this.props.server.address, 'toolHead': this.props.toolHead.laserToolhead });
            const res = JSON.parse(resPro.body.res.text);
            this.setState({
                manualPoints: res.points,
                matrix: res
            });
            this.setState({
                panel: PANEL_MANUAL_CALIBRATION
            });
        }
    };


    timer = null;

    componentDidMount() {
        let picAmount = 1;
        if (this.props.toolHead.laserToolhead === LEVEL_TWO_POWER_LASER_FOR_SM2) {
            picAmount = 1;
        } else if (this.props.toolHead.laserToolhead === LEVEL_ONE_POWER_LASER_FOR_SM2) {
            picAmount = this.props.series === MACHINE_SERIES.A150.value ? 4 : 9;
        }
        this.setState({
            panel: PANEL_EXTRACT_TRACE,
            getPhotoTasks: [],
            imageNames: [],
            manualPoints: [],
            matrix: '',
            xSize: this.props.xSize,
            ySize: this.props.ySize,
            shouldCalibrate: false,
            isStitched: false,
            canStart: true,
            outputFilename: '',
            options: {
                picAmount: picAmount,
                currentIndex: 0,
                size: this.props.size,
                series: this.props.series,
                centerDis: 100,
                currentArrIndex: 0,
                getPoints: [],
                corners: [],
                fileNames: [],
                stitchFileName: ''
            }
        });

        for (let i = 0; i < picAmount; i++) {
            this.extractingPreview[i] = React.createRef();
        }

        if (this.props.lastFileNames && this.props.lastFileNames.length > 0) {
            this.setState({
                canStart: false
            });
            this.actions.updateStitchEach();
            this.setState({
                canStart: true
            });
        }
    }

    componentWillUnmount() {
        this.close = true;
    }

    swapItem(imagesName, item1, item2) {
        const swap = imagesName[item1];
        imagesName[item1] = imagesName[item2];
        imagesName[item2] = swap;
    }

    render() {
        if (this.props.series === MACHINE_SERIES.A400.value) {
            this.multiple = 1.25;
        } else if (this.props.series === MACHINE_SERIES.A350.value) {
            this.multiple = 1.5;
        } else {
            this.multiple = 2;
        }
        return (
            <div>
                <div className="clearfix" />
                <div style={{ display: this.state.panel === PANEL_EXTRACT_TRACE ? 'block' : 'none' }}>
                    <Modal onClose={this.props.hideModal}>
                        <Modal.Header>
                            {i18n._('key-Laser/CameraCapture-Camera Capture')}
                        </Modal.Header>
                        <Modal.Body>
                            <div style={{ margin: '0 0 16px', width: '432px' }}>
                                {i18n._('key-Laser/CameraCapture-The camera on the Laser Module captures nine images of the Laser Engraving and Cutting Platform, and stitches them as a background.')}
                            </div>
                            <Spin spinning={this.state.loading} className={classNames(styles.spin)} tip={i18n._('key-StackedModel/Import-Loading')}>
                                <div
                                    className={classNames(styles['photo-display'], 'border-radius-8')}
                                    style={{ height: this.props.laserSize.y * 0.85 * this.multiple + 2, width: this.props.laserSize.x * 0.85 * this.multiple + 2 }}
                                >
                                    {this.extractingPreview.map((previewId, index) => {
                                        const key = previewId + index;
                                        return (
                                            <ExtractPreview
                                                size={this.props.laserSize}
                                                series={this.props.series}
                                                toolHead={this.props.toolHead}
                                                ref={previewId}
                                                key={key}
                                            />
                                        );
                                    })}
                                    <div
                                        className={styles['start-background']}
                                        style={{ display: this.state.canStart ? 'inline-block' : 'none', margin: '0 auto', width: 'auto' }}

                                    >
                                        <Button
                                            priority="level-two"
                                            width="160px"
                                            onClick={this.actions.startCameraAid}
                                        >
                                            {i18n._('key-Laser/CameraCapture-Start')}
                                        </Button>
                                    </div>
                                </div>
                            </Spin>
                            <div style={{ minHeight: 30, width: this.props.laserSize.x * 0.85 * this.multiple + 2 }}>
                                <div className="clearfix" />
                                <Button
                                    priority="level-two"
                                    type="default"
                                    width="160px"
                                    className={classNames(
                                        styles[this.props.canTakePhoto ? 'btn-camera' : 'btn-camera-disabled'],
                                        'margin-top-16'
                                    )}
                                    onClick={this.actions.displayManualCalibration}
                                    disabled={!this.props.canTakePhoto}
                                >
                                    {i18n._('key-Laser/CameraCapture-Calibrate')}
                                </Button>
                            </div>
                        </Modal.Body>
                        <Modal.Footer>
                            <Button
                                priority="level-two"
                                width="96px"
                                className={classNames(
                                    styles[this.state.isStitched ? 'btn-right-camera' : 'btn-right-camera-disabled border-radius-8'],
                                )}
                                onClick={this.actions.setBackgroundImage}
                                disabled={!this.state.isStitched}
                            >
                                {i18n._('key-Laser/CameraCapture-Confirm')}
                            </Button>
                        </Modal.Footer>
                    </Modal>
                </div>
                {this.state.panel === PANEL_MANUAL_CALIBRATION && (
                    <ManualCalibration
                        toolHead={this.props.toolHead}
                        backtoCalibrationModal={this.actions.backtoCalibrationModal}
                        getPoints={this.state.manualPoints}
                        matrix={this.state.matrix}
                        updateAffinePoints={this.actions.updateAffinePoints}
                        shouldCalibrate={this.state.shouldCalibrate}
                        displayExtractTrace={this.actions.displayExtractTrace}
                        updateStitchEach={this.actions.updateStitchEach}
                        calibrationOnOff={this.actions.calibrationOnOff}
                    />
                )}
            </div>
        );
    }
}

const mapStateToProps = (state) => {
    const machine = state.machine;
    const headType = getCurrentHeadType(window.location.href);
    return {
        series: machine.series,
        headType,
        size: machine.size,
        server: machine.server,
        laserSize: machine.laserSize
    };
};

const mapDispatchToProps = (dispatch) => {
    return {
        executeGcodeG54: (series, headType) => dispatch(actions.executeGcodeG54(series, headType))
    };
};

export default connect(mapStateToProps, mapDispatchToProps)(ExtractSquareTrace);
