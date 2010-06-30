var sys = require('sys'),
    http = require('http'),
    querystring = require('querystring'),
    url = require('url'),
    bencode = require('./bencode'),
    Buffer = require('buffer').Buffer;

var debug = (function() {
    var fs = require('fs');
    var debug_file = fs.openSync('/tmp/bitor.debug', 'w');

    return function(msg) {
        sys.debug(msg);
        fs.write(debug_file, msg + '\n');
    };
})();

var Peer = (function() {
    var Peer = function(id, file) {
        this.id = id;
        this.file = file;
        this.state = 'unknown';
        this.last_action_time = new Date();
    };

    Peer.prototype = {
        update_status: function(query) {
            if (typeof(query.uploaded) !== 'undefined')
                this.uploaded = parseInt(query.uploaded);
            if (typeof(query.downloaded) !== 'undefined')
                this.downloaded = parseInt(query.downloaded);
            if (typeof(query.left) !== 'undefined') {
                this.left = parseInt(query.left);
                if (this.left === 0 && this.state != 'seeding') {
                    if (this.state == 'leeching') {
                        this.file.leechers -= 1;
                    }
                    this.state = 'seeding';
                    this.file.seeders += 1;
                }
            }

            if (query.event) {
                switch(query.event) {
                    case 'started':
                        if (this.state == 'unknown') {
                            /* Note: Will not be `unknown` if we just hit left=0, so this must be a leecher. */
                            this.file.leechers += 1;
                            this.state = 'leeching';
                        }
                        break;
                    case 'stopped':
                        if (this.state == 'leeching')
                            this.file.leechers -= 1;
                        else if (this.state == 'seeding')
                            this.file.seeders -= 1;
                        break;
                    case 'completed':
                        if (this.state == 'leeching')
                            this.file.leechers -= 1;
                        if (this.state != 'seeding')
                            this.file.seeders += 1;
                        this.state = 'seeding';
                        break;
                    default:
                        return;
                }
            }
        },

        dict: function (no_peer_id) {
            /* TODO: Memoize the bencoded output of this every time `peer.port`, `peer.ip` changes,
             *       and take `no_peer_id` into concideration when doing this as well. */
            var ret = {
                ip: this.ip,
                port: this.port
            };
            if (!no_peer_id) {
                ret.id = this.id;
            }

            return ret;
        },

        compact: function() {
            /* TODO: Memoize the output of this every time `peer.port` or `peer.ip` changes */
            var ret = '';
            var ip_numbers = this.ip.split('.');
            if (ip_numbers.length !== 4)
                return '';

            for (var i = 0; i < 4; ++i) {
                var n = parseInt(ip_numbers[i]);
                if (!n || n > 255) {
                    debug('Invalid IP: ' + this.ip);
                    return '';
                }

                ret += String.fromCharCode(n);
            }

            if (this.port <= 0 || this.port >= 65536)
                return '';

            ret += String.fromCharCode(this.port >> 8);
            ret += String.fromCharCode(this.port & 255);

            return ret;
        }
    };

    return Peer;
})();

var File = (function() {
    var File = function(hash) {
        this.hash = hash;
        this.peers = [];

        this.seeders = 0;
        this.leechers = 0;
    }

    File.prototype = {
        get_peer: function(id) {
            var peer;
            for (var i = 0; i < this.peers.length; ++i) {
                if (this.peers[i].id === id) {
                    peer = this.peers[i];
                    break;
                }
            }

            if (!peer) {
                peer = new Peer(id, this);
                this.peers.push(peer);
            } else {
                peer.last_action_time = new Date();
            }
            return peer;
        },
        get_peers: function(numwant, current_peer) {
            var peers = this.peers.filter(function(peer) {
                return peer != current_peer;
            });

            if (numwant >= peers.length) {
                return peers;
            }

            var ret = [],
                chosen = {};
            /* Randomly fetch a new peer until we reach `numwant` peers. 
             * TODO: Take `peer.completed` into concideration. */
            while (numwant--) {
                var idx = Math.floor(Math.random() * peers.length);
                if (chosen[idx])
                    continue;

                chosen[idx] = true;
                ret.push(peers[idx]);
            }
            return ret;
        },
    }

    return File;
})();

var Bitor = (function() {
    var Bitor = function(config) {
        this.ip = config.ip;
        this.port = config.port;
        this.files = [];

        this.default_numwant = config.numwant || 50;
        this.announce_url = (config.announce_url || '/announce').replace(/\/$/, '');
        this.interval = config.interval || 60;
        this.idle_ms_limit = config.idle_ms_limit || (10 * 60 * 1000);
    };

    Bitor.prototype = {
        remove_old_peers: function() {
            var now = new Date();
            for (var i = 0; i < this.files.length; ++i) {
                var file = this.files[i];
                for (var j = 0; j < file.peers.length; ++j) {
                    var peer = file.peers[j];
                    if (now - peer.last_action_time > this.idle_ms_limit) {
                        file.peers[j].file = null;
                        file.peers.splice(j, 1);
                        --j;
                    }
                }

                if (file.peers.length == 0) {
                    this.files.splice(i, 1);
                    --i;
                }
            }
        },

        get_file: function(info_hash) {
            var file;
            for (var i = 0; i < this.files.length; ++i) {
                if (this.files[i].hash === info_hash) {
                    file = this.files[i];
                    break;
                }
            }

            if (!file) {
                var file = new File(info_hash);
                this.files.push(file);
            }
            return file;
        },

        start: function() {
            var me = this;

            this.server = http.createServer(function (req, res) {
                function send_error(errno, msg) {
                    debug(msg);
                    var response = bencode.encode({'failure': msg, 'failure code': errno});
                    res.writeHead(200, {'Content-Type': 'text/plain',
                                        'Content-Length': (new Buffer(response)).length});
                    res.write(response);
                    res.end();
                }

                if (req.method !== 'GET') {
                    return send_error(100, 'Invalid request type: client request was not a HTTP GET.');
                }

                var request = url.parse(req.url);
                if (request.pathname.replace(/\/$/, '') === me.announce_url) {
                    var query = querystring.parse(request.query);

                    debug('New connection. url: ' + req.url);
                    debug('Remote address: ' + req.socket.remoteAddress);

                    /* Some more errorchecking */
                    if (typeof(query.info_hash) === 'undefined') {
                        return send_error(101, 'Missing info_hash.');
                    } else if ((new Buffer(query.info_hash, 'binary')).length < 15) {
                        return send_error(150, 'Invalid infohash (' + query.info_hash + '): infohash is only ' + query.info_hash.length + ' bytes long.');
                    }

                    if (typeof(query.peer_id) === 'undefined') {
                        return send_error(102, 'Missing peer_id.');
                    } else if ((new Buffer(query.peer_id, 'binary')).length < 15) {
                        return send_error(151, 'Invalid peerid (' + query.peer_id + '): peerid is only ' + query.peer_id.length + ' bytes long.');
                    }

                    if (typeof(query.port) === 'undefined') {
                        return send_error(103, 'Missing port.');
                    }

                    /* Fetch or create both a `file` object and a `peer` object. */
                    var file = me.get_file(query.info_hash);
                    var peer = file.get_peer(query.peer_id);

                    /* Update the peer instance with any new info from the request. */
                    peer.port = query.port;
                    if (typeof(query.ip) !== 'undefined') {
                        peer.ip = query.ip;
                    } else {
                        peer.ip = req.socket.remoteAddress;
                    }

                    peer.update_status(query);
                    if (query.event === 'stopped') {
                        file.peers.splice(file.peers.indexOf(peer), 1);
                        res.writeHead(200, {'Content-Type': 'text/plain',
                                            'Content-Length': 0});
                        return res.end();
                    }

                    /* Create a response */
                    var numwant = query.numwant || me.default_numwant;
                    var peers = file.get_peers(numwant, peer);

                    var response =  {
                        'interval': me.interval,
                        'seeders': file.seeders,
                        'leechers': file.leechers,
                    }

                    /* The response will vary, depending on (lack of) the query parameters `compact` and `no_peer_id`. */
                    if (typeof(query.compact) !== 'undefined') {
                        response.peers = peers.map(function(peer) {
                            return peer.compact();
                        }).join('');
                    } else {
                        response.peers = peers.map(function(peer) {
                            return peer.dict(typeof(query.no_peer_id) !== 'undefined');
                        });
                    }

                    response = bencode.encode_dict(response);
                    debug('Sending back: "' + response + '"');

                    res.writeHead(200, {'Content-Type': 'text/plain',
                                        'Content-Length': (new Buffer(response, 'binary')).length});
                    res.write(response, 'binary');
                    return res.end();
                }

                return send_error(600, 'Invalid URL.');
            });

            this.server.listen(this.port, this.ip, function() {
                sys.puts('Server running at http://' + me.ip + ':' + me.port + '/');

                /* Every 5 minutes, we'll iterate through all peers and remove any idle ones. */
                setInterval(function() {
                    me.remove_old_peers();
                }, 5 * 60 * 1000);
            });
        },
    };

    return Bitor;
})();

exports.Bitor = Bitor;
exports.debug = debug;
