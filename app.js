const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const SearchEngine = require('./SearchEngine.js');
const MediathekIndexer = require('./MediathekIndexer.js');
const Hjson = require('hjson');
const exec = require('child_process').exec;
const PiwikTracker = require('piwik-tracker');
const utils = require('./utils.js');


const config = Hjson.parse(fs.readFileSync('config.hjson', 'utf8'));
config.mediathekUpdateInterval = parseFloat(config.mediathekUpdateInterval) * 60;
if (config.redis.password == '') {
    delete config.redis.password; //to prevent warning message
}

if (config.postgres.enabled) {
    const sql = require('./postgres.js');
    sql.init(config.postgres);
    sql.createQueriesTable();
}

if (config.piwik.enabled) {
    var piwik = new PiwikTracker(config.piwik.siteId, config.piwik.piwikUrl);
}

var app = express();
var httpServer = http.Server(app);
var io = require('socket.io')(httpServer);

var searchEngine = new SearchEngine(config.redis);
var mediathekIndexer = new MediathekIndexer(config.workerCount, config.redis, config.elasticsearch);
var websiteNames = [];

var indexing = false;
var lastIndexingState;

if (!!piwik) {
    piwik.on('error', function(err) {
        console.log('piwik: error tracking request: ', err)
    });
}

app.use('/static', express.static('static'));

app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname + '/index.html'));
});
app.get('/impressum', function(req, res) {
    res.sendFile(path.join(__dirname + '/impressum.html'));
});
app.get('/datenschutz', function(req, res) {
    res.sendFile(path.join(__dirname + '/datenschutz.html'));
});

io.on('connection', (socket) => {
    var clientIp = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress.match(/(\d+\.?)+/g)[0];
    var socketUid = null;

    console.log('client connected, ip: ' + clientIp);

    if (indexing && lastIndexingState != null) {
        socket.emit('indexState', lastIndexingState);
    }

    socket.on('queryEntry', (query) => {
        if (indexing) {
            return;
        }

        queryEntries(query.queryString, query.searchTopic, query.future, (result) => {
            socket.emit('queryResult', result);

            if (config.postgres.enabled) {
                sql.addQueryRow(query.queryString, result.queryInfo.searchEngineTime);
            }
        });
    });

    function emitNewUid() {
        socket.emit('uid', utils.randomValueBase64(32));
    }

    socket.on('requestUid', () => {
        emitNewUid();
    });

    socket.on('track', (data) => {
        if (!data.uid || data.uid.length != 32) {
            emitNewUid();
            return;
        }

        if (!socketUid) {
            socketUid = data.uid;
        } else if (data.uid != socketUid) {
            socket.emit('uid', socketUid);
            return;
        }

        if (!!piwik) {
            piwik.track({
                pv_id: data.pv_id,
                token_auth: config.piwik.token_auth,
                url: config.piwik.websiteUrl,
                uid: socketUid,
                cip: clientIp,
                ua: data.ua,
                lang: data.lang,
                res: data.res,
                e_c: data.e_c,
                e_a: data.action
            });
        }
    });
});

httpServer.listen(config.webserverPort, () => {
    console.log('server listening on *:' + config.webserverPort);
    console.log();
});

function queryEntries(query, searchTopic, future, callback) {
    let begin = process.hrtime();
    searchEngine.search(query, searchTopic, future, (result, err) => {
        let end = process.hrtime(begin);

        if (err) {
            console.error(err);
            callback([]);
            return;
        }

        let searchEngineTime = (end[0] * 1e3 + end[1] / 1e6).toFixed(2);

        let queryInfo = {
            searchEngineTime: searchEngineTime,
            resultCount: result.result.length,
            totalResults: result.totalResults
        };

        callback({
            results: result.result,
            queryInfo: queryInfo
        });

        console.log(moment().format('HH:mm') + ' - querying "' + query + '" took ' + searchEngineTime + ' ms');
    });
}

mediathekIndexer.on('state', (state) => {
    lastIndexingState = state;
    io.sockets.emit('indexState', state);

    console.log();
    console.log('\tpprogress: ' + (state.parserProgress * 100).toFixed(2) + '%');
    console.log('\tiprogress: ' + (state.indexingProgress * 100).toFixed(2) + '%');
    console.log('\ttotalEntries: ' + state.totalEntries);
    console.log('\tentries: ' + state.entries);
    console.log('\tdone: ' + state.done);
    console.log('\ttime: ' + (state.time / 1000) + ' seconds');

    if (state.done) {
        indexing = false;
        console.log();
    }
});

function downloadFilmliste(successCallback, errCallback) {
    let content = "";
    let req = http.get('http://zdfmediathk.sourceforge.net/akt.xml', function(res) {
        res.setEncoding("utf8");
        res.on("data", function(chunk) {
            content += chunk;
        });

        res.on("end", function() {
            let filmlisteUrlRegex = /<URL>\s*(.*?)\s*<\/URL>/g;
            let urlMatches = [];

            let match;
            while ((match = filmlisteUrlRegex.exec(content)) !== null) {
                urlMatches.push(match);
            }

            let url = urlMatches[Math.floor(Math.random() * urlMatches.length)][1];

            let request = http.get(url, function(response) {
                let filename = config.filmliste + '.xz';
                fs.stat(filename, (err, stats) => {
                    if (!err) {
                        fs.unlinkSync(filename);
                    }
                    let fileStream = fs.createWriteStream(config.filmliste + '.xz');
                    response.pipe(fileStream);
                    response.on('end', () => {
                        fs.stat(config.filmliste, (err, stats) => {
                            if (!err) {
                                fs.unlinkSync(config.filmliste);
                            }

                            exec('unxz ' + config.filmliste + '.xz').on('exit', () => {
                                successCallback();
                            });
                        });
                    });
                });
            });

            request.on('error', (e) => {
                errCallback(e);
            });
        });
    });
    req.end();
}

function indexMediathek(callback) {
    indexing = true;
    mediathekIndexer.indexFile(config.filmliste, config.substrSize, callback);
}

function checkUpdateNeeded(callback) {
    mediathekIndexer.getLastIndexHasCompleted((completed) => {
        if (completed) {
            mediathekIndexer.getLastIndexTimestamp((result) => {
                if ((parseInt(result) + config.mediathekUpdateInterval) <= (Date.now() / 1000)) {
                    callback(true);
                } else {
                    callback(false);
                }
            });
        } else {
            callback(true);
        }
    });
}

function updateLoop() {
    if (!config.index) {
        return;
    }

    checkUpdateNeeded((updateNeeded) => {
        if (updateNeeded) {
            downloadFilmliste(() => {
                indexMediathek(() => {
                    setTimeout(updateLoop, 60 * 1000);
                });
            }, (err) => {
                console.error('download error: ' + err.message);
                console.error('trying again in 15 seconds');
                setTimeout(updateLoop, 15 * 1000);
            });
        } else {
            setTimeout(updateLoop, 60 * 1000);
        }
    });
}

setImmediate(updateLoop);
