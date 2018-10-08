define([
        '../Core/Cartesian3',
        '../Core/ComponentDatatype',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/IndexDatatype',
        '../Renderer/Buffer',
        '../Renderer/BufferUsage',
        '../Renderer/ComputeCommand',
        '../Renderer/ShaderProgram',
        '../Renderer/Texture',
        '../Renderer/VertexArray',
        '../Shaders/OctahedralProjectionAtlasFS',
        '../Shaders/OctahedralProjectionFS',
        '../Shaders/OctahedralProjectionVS'
    ], function(
        Cartesian3,
        ComponentDatatype,
        defined,
        defineProperties,
        destroyObject,
        IndexDatatype,
        Buffer,
        BufferUsage,
        ComputeCommand,
        ShaderProgram,
        Texture,
        VertexArray,
        OctahedralProjectionAtlasFS,
        OctahedralProjectionFS,
        OctahedralProjectionVS) {
    'use strict';

    /**
     * A function to project an environment cube map onto a flat octahedron.
     *
     * The goal is to pack all convolutions. When EXT_texture_lod is available,
     * they are stored as mip levels. When the extension is not supported, we
     * pack them into a 2D texture atlas.
     *
     * Octahedral projection is a way of putting the cube maps onto a 2D texture
     * with minimal distortion and easy look up.
     * See Chapter 16 of WebGL Insights "HDR Image-Based Lighting on the Web" by Jeff Russell
     * and "Octahedron Environment Maps" for reference.
     *
     * @param {CubeMap[]} cubeMaps An array of {@link CubeMap}s to pack.
     */
    function OctahedralProjectedCubeMap(cubeMaps) {
        this._cubeMaps = cubeMaps;

        this._texture = undefined;
        this._mipTextures = undefined;
        this._va = undefined;
        this._sp = undefined;

        this._maximumMipmapLevel = undefined;
    }

    defineProperties(OctahedralProjectedCubeMap.prototype, {
        /**
         * A texture containing all the packed convolutions.
         * @memberof {OctahedralProjectedCubeMap.prototype}
         * @type {Texture}
         */
        texture : {
            get : function() {
                return this._texture;
            }
        },
        maximumMipmapLevel : {
            get : function() {
                return this._maximumMipmapLevel;
            }
        }
    });

    // These vertices are based on figure 1 from "Octahedron Environment Maps".
    var v1 = new Cartesian3(1.0, 0.0, 0.0);
    var v2 = new Cartesian3(0.0, 0.0, -1.0);
    var v3 = new Cartesian3(-1.0, 0.0, 0.0);
    var v4 = new Cartesian3(0.0, 0.0, 1.0);
    var v5 = new Cartesian3(0.0, 1.0, 0.0);
    var v6 = new Cartesian3(0.0, -1.0, 0.0);

    // top left, left, top, center, right, top right, bottom, bottom left, bottom right
    var cubeMapCoordinates = [v5, v3, v2, v6, v1, v5, v4, v5, v5];
    var length = cubeMapCoordinates.length;
    var flatCubeMapCoordinates = new Float32Array(length * 3);

    var offset = 0;
    for (var i = 0; i < length; ++i, offset += 3) {
        Cartesian3.pack(cubeMapCoordinates[i], flatCubeMapCoordinates, offset);
    }

    var flatPositions = new Float32Array([
        -1.0,  1.0, // top left
        -1.0,  0.0, // left
         0.0,  1.0, // top
         0.0,  0.0, // center
         1.0,  0.0, // right
         1.0,  1.0, // top right
         0.0, -1.0, // bottom
        -1.0, -1.0, // bottom left
         1.0, -1.0  // bottom right
    ]);
    var indices = new Uint16Array([
        0, 1, 2, // top left, left, top,
        2, 3, 1, // top, center, left,
        7, 6, 1, // bottom left, bottom, left,
        3, 6, 1, // center, bottom, left,
        2, 5, 4, // top, top right, right,
        3, 4, 2, // center, right, top,
        4, 8, 6, // right, bottom right, bottom,
        3, 4, 6  //center, right, bottom
    ]);

    function createVertexArray(context) {
        var positionBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : flatPositions,
            usage : BufferUsage.STATIC_DRAW
        });
        var cubeMapCoordinatesBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : flatCubeMapCoordinates,
            usage : BufferUsage.STATIC_DRAW
        });
        var indexBuffer = Buffer.createIndexBuffer({
            context : context,
            typedArray : indices,
            usage : BufferUsage.STATIC_DRAW,
            indexDatatype : IndexDatatype.UNSIGNED_SHORT
        });

        var attributes = [{
            index                  : 0,
            vertexBuffer           : positionBuffer,
            componentsPerAttribute : 2,
            componentDatatype      : ComponentDatatype.FLOAT
        }, {
            index                  : 1,
            vertexBuffer           : cubeMapCoordinatesBuffer,
            componentsPerAttribute : 3,
            componentDatatype      : ComponentDatatype.FLOAT
        }];
        return new VertexArray({
            context : context,
            attributes : attributes,
            indexBuffer : indexBuffer
        });
    }

    function createUniformTexture(texture) {
        return function() {
            return texture;
        };
    }

    function cleanupResources(map) {
        map._va = map._va && map._va.destroy();
        map._sp = map._sp && map._sp.destroy();

        var mipTextures = map._mipTextures;
        if (defined(mipTextures)) {
            var length = mipTextures.length;
            for (var i = 0; i < length; ++i) {
                mipTextures[i].destroy();
            }
        }
    }

    OctahedralProjectedCubeMap.prototype.update = function(frameState) {
        if (defined(this._va)) {
            cleanupResources(this);
        }
        if (defined(this._texture)) {
            return;
        }

        var context = frameState.context;
        var cubeMaps = this._cubeMaps;

        this._va = createVertexArray(context);
        this._sp = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : OctahedralProjectionVS,
            fragmentShaderSource : OctahedralProjectionFS,
            attributeLocations : {
                position : 0,
                cubeMapCoordinates : 1
            }
        });

        // We only need up to 6 mip levels to avoid artifacts.
        var length = Math.min(cubeMaps.length, 6);
        this._maximumMipmapLevel = length - 1;
        var mipTextures = this._mipTextures = new Array(length);
        var originalSize = cubeMaps[0].width * 2.0;
        var uniformMap = {
            originalSize : function() {
                return originalSize;
            }
        };

        // First we project each cubemap onto a flat octahedron, and write that to a texture.
        for (var i = 0; i < length; ++i) {
            var size = cubeMaps[i].width * 2;

            var mipTexture = mipTextures[i] = new Texture({
                context : context,
                width : size,
                height : size,
                pixelDataType : cubeMaps[i].pixelDatatype,
                pixelFormat : cubeMaps[i].pixelFormat
            });

            var command = new ComputeCommand({
                vertexArray : this._va,
                shaderProgram : this._sp,
                uniformMap : {
                    cubeMap : createUniformTexture(cubeMaps[i])
                },
                outputTexture : mipTexture,
                persists : true,
                owner : this
            });
            frameState.commandList.push(command);

            uniformMap['texture' + i] = createUniformTexture(mipTexture);
        }

        this._texture = new Texture({
            context : context,
            width : originalSize * 1.5 + 2.0, // We add a 1 pixel border to avoid linear sampling artifacts.
            height : originalSize,
            pixelDataType : cubeMaps[0].pixelDatatype,
            pixelFormat : cubeMaps[0].pixelFormat
        });

        var atlasCommand = new ComputeCommand({
            fragmentShaderSource : OctahedralProjectionAtlasFS,
            uniformMap : uniformMap,
            outputTexture : this._texture,
            persists : false,
            owner : this
        });
        frameState.commandList.push(atlasCommand);
    };

    OctahedralProjectedCubeMap.prototype.isDestroyed = function() {
        return false;
    };

    OctahedralProjectedCubeMap.prototype.destroy = function() {
        cleanupResources(this);
        this._texture = this._texture && this._texture.destroy();
        return destroyObject(this);
    };

    return OctahedralProjectedCubeMap;
});
