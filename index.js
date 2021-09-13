const systemglobal = require('./config.json');

const os = require('os');
const disk = require('diskusage');
const amqp = require('amqplib/callback_api');
const calExpander = require('ical-expander');
const moment = require('moment');
const https = require('https');
const cron = require('node-cron');
const MQServer = `amqp://${systemglobal.MQUsername}:${systemglobal.MQPassword}@${systemglobal.MQServer}/?heartbeat=60`
let amqpConn = null;
let pubChannel = null;
const daysOfWeek = ['SU','MO','TU','WE','TH','FR', 'SA']



function publish(exchange, routingKey, content, callback) {
    try {
        pubChannel.publish(exchange, routingKey, content, { persistent: true },
            function(err, ok) {
                if (err) {
                    console.error("KanmiMQ - Failed to Publish Message")
                    pubChannel.connection.close();
                    callback(false)
                } else {
                    callback(true)
                }
            });
    } catch (e) {
        console.error("KanmiMQ - Publish Error")
        console.error(e)
        callback(false)
    }
}
function sendData(client, content, ok) {
    let exchange = "kanmi.exchange";
    publish(exchange, client, new Buffer.from(JSON.stringify(content), 'utf-8'), function (callback) {
        if (callback) {
            ok(true);
        } else {
            ok(false)
        }
    });
}
function closeOnErr(err) {
    if (!err) return false;
    console.error("KanmiMQ - Connection Closed due to error")
    amqpConn.close();
    return true;
}

function getCalenders() {
    if (systemglobal.CalenderEvents) {
        systemglobal.CalenderEvents.forEach((calender) => {
            if (calender.url) {
                https.get(calender.url.replace('webcal://', 'https://'), (resp) => {
                    resp.setEncoding('utf8');
                    let data = '';
                    resp.on('data', (chunk) => {
                        data += chunk;
                    });
                    resp.on('end', () => {
                        getCalenderEvent(data, calender)
                    });

                }).on('error', (err) => {
                    if (err) {
                        console.error('Failed to get calender from URL')
                    }
                });
            }
        })
    }
}
function getCalenderEvent(data, calender){
    const ical = new calExpander({
        ics: data,
        maxIterations: 1000
    });
    const now = new Date();
    const start = new Date(now.getTime());
    const end = new Date(now.getTime() + 48 * 3600 * 1000); // 30 Min Ahead
    const cal = ical.between(start, end);

    let foundEvents = new Map();
    Object.values(cal).forEach(function(cal_type){
        cal_type.forEach(function(events){ // Process Single and Reoccurring Events
            let event = {};
            let date = 0;
            let element = undefined
            if (events.item) {
                element = events.item
            } else {
                element = events
            }
            const reoccurrence = element.component.jCal[1].filter(e => { return e[0] === 'rrule' }).map(e => { if (e.indexOf('recur') !== -1) { return e[e.indexOf('recur') + 1] } })
            const eventName = element.component.jCal[1].filter(e => { return e[0] === 'summary' }).map(e => { if (e.indexOf('text') !== -1) { return e[e.indexOf('text') + 1] } })
            const eventStart = element.component.jCal[1].filter(e => { return e[0] === 'dtstart' }).map(e => { if (e.indexOf('date-time') !== -1) { return e[e.indexOf('date-time') + 1] } })
            if (eventName.length > 0) {
                event.name = eventName[0]
            }
            const _eventTime = moment(new Date(eventStart[0]));
            if (reoccurrence.length > 0 && reoccurrence[0].freq === 'WEEKLY') {
                let eventTime = undefined;
                if (reoccurrence[0].byday) {
                    let _weekStart = moment().startOf('week').add(daysOfWeek.indexOf(reoccurrence[0].byday), 'days');
                    if (_weekStart.day() < moment().day()) {
                        _weekStart = moment().startOf('week').add(daysOfWeek.indexOf(reoccurrence[0].byday) + 7, 'days');
                    }
                    eventTime = _weekStart.hour(_eventTime.format('HH')).minute(_eventTime.format('mm'));
                } else {
                    const _dayOfWeek = _eventTime.day();
                    _weekStart = moment().startOf('week').add(_dayOfWeek, 'days');
                    if (_weekStart.day() < moment().day()) {
                        _weekStart = moment().startOf('week').add(_dayOfWeek + 7, 'days');
                    }
                    eventTime = _weekStart.hour(_eventTime.format('HH')).minute(_eventTime.format('mm'));
                }
                event.time = eventTime.format('HH:mm');
                date = eventTime.valueOf();
            } else {
                event.time = _eventTime.format('HH:mm');
                date = _eventTime.valueOf();
            }
            if (date <= Date.now()) {
                event.now = 2
            } else if (date <= moment().add(1, 'hours').valueOf()) {
                event.now = 1
            } else {
                event.now = 0
            }
            foundEvents.set(date, event);
        })
    })

    // Prints Current Airing Event
    const keys = Array.from(foundEvents.keys()).sort();
    let messageText = ''
    if (calender.header) {
        messageText += calender.header + ' ';
    }
    if (keys.length > 0) {
        const eventData = foundEvents.get(keys[0])
        let eventName = eventData.name
        if (calender.replacements && calender.replacements.length > 0) {
            calender.replacements.forEach(rep => {
                eventName = eventName.replace(rep.from, rep.to);
            })
        }
        if (eventData.now === 2) {
            messageText += '🔴 '
        } else if (eventData.now === 1) {
            messageText += '🔶 '
        }
        messageText += `${eventData.time}:${eventName}`
    } else {
        if (calender.noEvents) {
            messageText += calender.noEvents
        } else {
            messageText += `No Events`
        }
    }
    sendData(systemglobal.MQDiscordInbox, {
        fromClient : `return.Calender.${systemglobal.SystemName}`,
        messageChannelName: calender.channel,
        messageChannelID: "0",
        messageReturn: false,
        messageType: 'status',
        messageText: messageText
    }, (ok) => {
        if (!ok) { console.error('Failed to send update to MQ') }
    })
}

function getDiskStatus() {
    if (systemglobal.StatusDisks) {
        systemglobal.StatusDisks.forEach((monDisk) => {
            if (monDisk.channel) {
                let diskValue = null;
                let diskPercent = null;
                let diskUsed = null;
                let diskFree = null;
                let diskTotal = null;

                new Promise(function (resolve, reject) {
                    try {
                        disk.check(monDisk.mount, function (err, info) {
                            //function toGB(x) { return (x / (1024 * 1024 * 1024)).toFixed(1); }
                            //diskUsed = ((info.total - info.free) / (1024 * 1024 * 1024)).toFixed(2);
                            diskPercent = (((info.total - info.free) / info.total) * 100);
                            diskUsed = ((info.total - info.free) / (1024 * 1024)).toFixed(8);
                            diskFree = ((info.free) / (1024 * 1024)).toFixed(8);
                            diskTotal = ((info.total) / (1024 * 1024)).toFixed(8);
                            if (monDisk.used) {
                                diskValue = diskUsed;
                            } else {
                                diskValue = diskFree;
                            }
                            return resolve()
                        });
                    } catch (e) {
                        return reject(e);
                    }
                    setTimeout(function () {
                        reject('timeout')
                    }, 2000)
                })

                if (diskValue && diskPercent) {
                    let _diskText;
                    let messageText = '';
                    let messageIcon;
                    if (diskValue >= 1000000) {
                        _diskText = `${(diskValue / (1024 * 1024)).toFixed(monDisk.precision)} TB`
                    } else if (diskValue >= 1000) {
                        _diskText = `${(diskValue / 1024).toFixed(monDisk.precision)} GB`
                    } else {
                        _diskText = `${diskValue.toFixed(monDisk.precision)} MB`
                    }
                    if (monDisk.header && monDisk.header.length > 0) {
                        messageText += `${monDisk.header} `
                    }

                    if (diskPercent >= monDisk.indicatorDang) {
                        messageIcon = '❌'
                    } else if (diskPercent >= monDisk.indicatorWarn) {
                        messageIcon = '⚠️'
                    } else {
                        messageIcon = '✅'
                    }
                    if (monDisk.indicator) {
                        messageText += messageIcon + ' '
                    }
                    messageText += _diskText
                    if (monDisk.percentage) {
                        messageText += ` (${diskPercent.toFixed(0)}%)`
                    }

                    sendData(systemglobal.MQDiscordInbox, {
                        fromClient: `return.DiskStatus.${systemglobal.SystemName}`,
                        messageChannelName: monDisk.channel,
                        messageChannelID: "0",
                        messageReturn: false,
                        messageType: 'status',
                        messageData: {
                            diskName: monDisk.name,
                            diskMount: monDisk.mount,
                            diskTotal: diskTotal,
                            diskUsed: diskUsed,
                            diskFree: diskFree,
                            diskPercent: diskPercent.toFixed(0),
                            statusText: messageText,
                            statusIcon: messageIcon
                        },
                        updateIndicators: true
                    }, (ok) => {
                        if (!ok) {
                            console.error('Failed to send update to MQ')
                        }
                    })
                } else {
                    console.error(`Did not get disk information for ${monDisk.channel}`)
                }
            } else {
                console.error('Disk Misconfiguration - No channel name')
            }
        })
    }
}
function startMonitoring() {
    setTimeout(getDiskStatus, 5000);
    setTimeout(getCalenders, 5000);
    setInterval(getDiskStatus, (systemglobal.diskRefreshInterval * 60000));
    cron.schedule('1,6,31,36 * * * *', getCalenders);
    process.send('ready');
}

amqp.connect(MQServer, function(err, conn) {
    if (err) {
        console.error("KanmiMQ - Initialization Error")
        return setTimeout(function () {
            process.exit(1)
        }, 1000);
    }
    conn.on("error", function(err) {
        if (err.message !== "Connection closing") {
            console.error("KanmiMQ - Initialization Connection Error")
        }
    });
    conn.on("close", function() {
        console.error("KanmiMQ - Attempting to Reconnect...")
        return setTimeout(function () {
            process.exit(1)
        }, 1000);
    });
    console.error(`KanmiMQ - Publisher Connected to Kanmi Exchange as ${systemglobal.SystemName}!`)
    amqpConn = conn;
    amqpConn.createConfirmChannel(function(err, ch) {
        if (closeOnErr(err)) return;
        ch.on("error", function(err) {
            console.error("KanmiMQ - Channel Error")
        });
        ch.on("close", function() {
            console.error("KanmiMQ - Channel Closed")
        });
        pubChannel = ch;
    });
    startMonitoring();
});
process.on('uncaughtException', function(err) {
    console.log(err)
    setTimeout(function() {
        process.exit(1)
    }, 3000)
});
