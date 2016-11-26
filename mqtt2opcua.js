"use strict";

var opcua = require("node-opcua"),
    mqtt = require('mqtt'),
    Events = require('events').EventEmitter,
    Qlobber = require('qlobber').Qlobber;


var  _debug  = false;



function debug(s) {
    if (_debug) {
        console.log(s);
    }
}


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
    if (Object.prototype.hasOwnProperty.call(this._events, topic)){
        return this._events[topic];
    }
    var matches = this.matcher.match(topic);
    return matches.length ? matches.pop() : null;
};

Matcher.prototype.init = function () {
    for (var e in this._events) {
        if (Object.prototype.hasOwnProperty.call(this._events, e)) {
            this.matcher.add(e, this._events[e]);
        }
    }
};

Matcher.prototype.hasDefault = function () {
    return this._events['#'] !== undefined;
};

var run = function (options) {

   _debug = options.debug || false;

 // Forward and backward handlers - see below for example
    var fhandlers = new Matcher(options.forward),
        bhandlers = new Matcher(options.backward);

    if (!fhandlers.hasDefault()) {
        fhandlers.on("#", function (payload) { // Default backward handler (MQTT -> OPCUA)
            return {
                dataType: "String",
                value: String(payload),
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


    // Let's create an instance of OPCUAServer

    var server = new opcua.OPCUAServer({
        hostname: options.opcHost || "127.0.0.1",
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
            paths = {},
            flagged = {};

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
                flagged[topic] = false;
                return;
            }

            var sub,
                path = topic.split("/"),
                top  = (path[0] || path[1]); // Cater for paths starting with "/"

            node = paths[top] = (paths.hasOwnProperty(top)) ? paths[top] :
                                server.engine.addressSpace.addFolder("ObjectsFolder", { browseName: top});

            for (sub in path) {
                if (sub == 0 |!path.hasOwnProperty(sub)) {
                    continue;
                }

                top += "/" + path[sub];
                if (topic !== top) {
                    node = paths[top] = (paths.hasOwnProperty(top)) ? paths[top] :
                                        server.engine.addressSpace.addFolder(node, { browseName: path[sub]});
                } else {
                    debug("Creating folders for new topic: " + topic);
                    persist[topic] = handler(payload).value;
                    flagged[topic] = false;
                    try {
                        nodes[topic] = server.engine.addressSpace.addVariable({
                            componentOf: node,
                            browseName: path[sub],
                            path: topic,
                            nodeId: "s=" + topic,
                            dataType: handler(payload).dataType,
                            value: {
                                get: function () {
                                    debug("OPCUA Get: " + topic);
                                    return (!flagged[topic]) ?
                                        new opcua.Variant(handler(persist[topic])) :
                                            opcua.StatusCodes.BadCommunicationError;
                                    },
                                set: function (variant) {
                                    debug("OPCUA Set: " + topic);
                                    try {
                                        variant.topic=topic;
                                        var bhandler = bhandlers.match(topic),
                                            message  = bhandler(variant);
                                        if (message.hasOwnProperty("topic") &&
                                            message.hasOwnProperty("payload")) {
                                                if (!options.roundtrip)
                                                    persist[topic] = message.payload;
                                                else
                                                    flagged[topic] = true;
                                                debug("MQTT Publish: " + message.topic.toString() + " (" + message.payload.toString().substr(0,8) + ")" )
                                                server.mqtt.publish(message.topic.toString(),
                                                                    message.payload.toString());
                                            }
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


        server.start(function (err) {
	    if (err){
	       console.error(err);
	       process.exit(1);
	    }

	    var endpointUrl = server.endpoints[0].endpointDescriptions()[0].endpointUrl;
            console.log("OPC Server is now available at: " + endpointUrl +  " ( press CTRL+C to stop)");

            var mqttURL = 'mqtt://' + (options.mqttHost || "localhost") + ":" + (options.mqttPort || "1883");

            if (!(server.mqtt = mqtt.connect(mqttURL,{ username: options.mqttUsername, password: options.mqttPassword}))) {
                console.error("MQTT Unable to connect");
                process.exit(1);
            }

            server.mqtt.on('connect', function () {
                console.log("MQTT Connected to: %s\n", mqttURL);
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
