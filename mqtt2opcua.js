"use strict";

var opcua = require("node-opcua"),
    mqtt = require('mqtt'),
    Events = require('events').EventEmitter,
    Qlobber = require('qlobber').Qlobber;


function Matcher(handlers) {
    Events.call(this);
    this.matcher = new Qlobber({
        separator: '/',
        wildcard_one: '+',
        wildcard_some: '#'
    });

    if (handlers.hasOwnProperty('_events')) {
        this._events = handlers._events;
    }
}

Matcher.prototype = Object.create(Events.prototype);
Matcher.prototype.match = function (topic) {
    var matches = this.matcher.match(topic);
    return matches.length ? matches.pop() : null;
};

Matcher.prototype.init = function () {
    var e;
    for (e in this._events) {
        if (this._events.hasOwnProperty(e)) {
            this.matcher.add(e, this._events[e]);
        }
    }
};

Matcher.prototype.hasDefault = function () {
    return this._events['#'] !== undefined;
};

var run = function (options) {

 // Forward and backward handlers - see below for example
    var fhandlers = new Matcher(options.forward),
        bhandlers = new Matcher(options.backward);

    if (!fhandlers.hasDefault()) {
        fhandlers.on("#", function (payload) { // Default backward handler (MQTT -> OPCUA)
            return {
                dataType: "Double",
                value: parseFloat(payload),
            };
        });
    }

    // Default backward handler

    if (!bhandlers.hasDefault()) {
        bhandlers.on("#", function (variant) { // Default backward handler (OPCUA -> MQTT)
            return {
                topic:variant.topic,
                payload:variant.value
            };
        });
    }

    fhandlers.init();
    bhandlers.init();

    function debug(s) {
        if (options.debug) {
            console.log(s);
        }
    }

    // Let's create an instance of OPCUAServer
    var server = new opcua.OPCUAServer({
        host: options.opcHost || "127.0.0.1",
        port: options.opcPort || 4334, // the port of the listening socket of the server
        resourcePath: options.opcName || "UA/MQTT Bridge Server", // this path will be added to the endpoint resource name
        buildInfo : {
            productName: "MQTT2OPCUA Bridge",
            buildNumber: "0.1",
            buildDate: new Date(2015, 20, 7)
        }
    });


    function post_initialize() {

        debug("OPC Server Initialized");
        var persist = {},    // New persistent store
            nodes = {},
            paths = {};

        function onMessage(topic, payload) {

            debug("MQTT onMessage: " + topic + " (" + payload.length + " bytes)");

            var node,
                handler = fhandlers.match(topic);

            if (!handler) {
                console.error("No handler defined for " + topic);
                return;
            }

            if (nodes.hasOwnProperty(topic)) {
                persist[topic] = handler(payload).value; // Note: need to handle null responses
                return;
            }

            var sub,
                path = topic.split("/"),
                top  = (path[0] || path[1]); // Cater for paths starting with "/"

            node = paths[top] = (paths.hasOwnProperty(top)) ? paths[top] :
                                server.engine.createFolder("ObjectsFolder", { browseName: top});

            for (sub in path) {
                if (sub == 0 |!path.hasOwnProperty(sub)) {
                    continue;
                }

                top += "/" + path[sub];
                if (topic !== top) {
                    node = paths[top] = (paths.hasOwnProperty(top)) ? paths[top] :
                                        server.engine.createFolder(node, { browseName: path[sub]});
                } else {
                    debug("Creating folders for new topic: " + topic);
                    persist[topic] = handler(payload).value;
                    try {
                        nodes[topic] = server.engine.addVariableInFolder(node, {
                            browseName: path[sub],
                            path: topic,
                            nodeId: "s=" + topic,
                            dataType: handler(payload).dataType,
                            value: {
                                get: function () {
                                    debug("OPCUA Get: " + topic);
                                    return new opcua.Variant(handler(persist[topic]));
                                },
                                set: function (variant) {
                                    debug("OPCUA Set: " + topic);
                                    try {
                                        variant.topic=topic;
                                        var bhandler = bhandlers.match(topic),
                                            message  = bhandler(variant);
                                        persist[topic] = message.payload;
                                        server.mqtt.publish(message.topic,message.payload);
                                    } catch(e){
                                        console.error(e);
                                    }
                                    return opcua.StatusCodes.Good;
                                }
                            }
                        });
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
            return;
        }


        server.start(function () {
            console.log("OPC Server is now listening ... ( press CTRL+C to stop)");

            var mqttURL = 'mqtt://' + (options.mqttHost || "localhost") + ":" + (options.mqttPort || "1883");

            if (!(server.mqtt = mqtt.connect(mqttURL))) {
                console.error("MQTT Unable to connect");
                process.exit(1);
            }

            server.mqtt.on('connect', function () {
                console.log("MQTT Connected on " + mqttURL);
                server.mqtt.subscribe(options.topics || ['$SYS/#', '#']);
            });

            server.mqtt.on('message', function (topic, message) {
                onMessage(topic, message);
            });

            server.mqtt.on('disconnect', function () {
                debug("MQTT Disconnected ");
                process.exit(1);
            });
        });
    }

    server.initialize(post_initialize);
};

module.exports.run = run;
