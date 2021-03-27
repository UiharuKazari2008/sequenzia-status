const systemglobal = require('./config.json');

const os = require('os');
const disk = require('diskusage');
const amqp = require('amqplib/callback_api');
const MQServer = `amqp://${systemglobal.MQUsername}:${systemglobal.MQPassword}@${systemglobal.MQServer}/?heartbeat=60`
let amqpConn = null;
let pubChannel = null;


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

function getDiskStatus() {
    systemglobal.StatusDisks.forEach((monDisk) => {
        if (monDisk.channel) {
            let diskValue = null;
            let diskPercent = null;

            new Promise(function(resolve, reject){
                try {
                    disk.check(monDisk.mount, function (err, info) {
                        //function toGB(x) { return (x / (1024 * 1024 * 1024)).toFixed(1); }
                        //diskUsed = ((info.total - info.free) / (1024 * 1024 * 1024)).toFixed(2);
                        diskPercent = ((info.total - info.free) / info.total).toFixed(2);
                        if (monDisk.used) {
                            diskValue = ((info.total - info.free) / (1024 * 1024)).toFixed(2);
                        } else {
                            diskValue = ((info.free) / (1024 * 1024)).toFixed(2)
                        }
                        return resolve()
                    });
                } catch (e) { return reject(e); }
                setTimeout(function(){reject('timeout')},2000)
            })

            if (diskValue && diskPercent) {
                let _diskText = '';
                let messageText = '';
                if (diskValue >= 1000000) {
                    _diskText = `${(diskValue / (1024 * 1024)).toFixed(monDisk.precision)} TB`
                } else if (diskValue >= 1000 ) {
                    _diskText = `${(diskValue / 1024).toFixed(monDisk.precision)} GB`
                } else {
                    _diskText = `${diskValue.toFixed(monDisk.precision)} MB`
                }
                if (monDisk.indicator) {
                    if (diskPercent >= monDisk.indicatorDang) {
                        messageText += '🔴 '
                    } else if (diskPercent >= monDisk.indicatorWarn) {
                        messageText += '🟡 '
                    } else {
                        messageText += '🟢 '
                    }
                }
                if (monDisk.header && monDisk.header.length > 0) {
                    messageText += `${monDisk.header} `
                }
                messageText += _diskText
                if (monDisk.percentage) {
                    messageText += ` (${diskPercent}%)`
                }

                sendData(systemglobal.MQDiscordInbox, {
                    fromClient : `return.DiskStatus.${systemglobal.SystemName}`,
                    messageChannelName: monDisk.channel,
                    messageChannelID: "0",
                    messageReturn: false,
                    messageType: 'status',
                    messageText: messageText
                }, (ok) => {
                    if (!ok) { console.error('Failed to send update to MQ') }
                })
            } else {
                console.error(`Did not get disk information for ${monDisk.channel}`)
            }
        } else {
            console.error('Disk Misconfiguration - No channel name')
        }
    })
}
function startMonitoring() {
    setTimeout(getDiskStatus, 5000);
    setInterval(getDiskStatus, (systemglobal.diskRefreshInterval * 60000))
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

