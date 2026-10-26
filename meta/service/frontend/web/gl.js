// WebGL sprite renderer. Each draw is a textured quad placed in pixel space on
// the canvas, blended with alpha. Used both for the character preview (one quad
// filling the canvas per layer) and the room game (tiles, furniture, player).

const VERT = `
precision highp float;
attribute vec2 a_xy;          // 0..1 within the destination quad
uniform vec4 u_uv;            // u0, v0, u1, v1 (v from image top)
uniform vec4 u_dst;           // x, y, w, h in pixels
uniform vec2 u_canvas;        // canvas w, h in pixels
varying vec2 v_uv;
void main() {
  v_uv = mix(u_uv.xy, u_uv.zw, a_xy);
  vec2 px = u_dst.xy + a_xy * u_dst.zw;
  vec2 ndc = vec2(px.x / u_canvas.x * 2.0 - 1.0, 1.0 - px.y / u_canvas.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

// Nearest sampling clamped to the sub-rect: a fractional destination position
// (the camera follows the player at sub-pixel offsets) can otherwise push an
// edge fragment a texel past u0/u1 onto the neighbouring frame in the sheet — a
// one-pixel bleed down one side of the sprite. Clamping to the half-texel-inset
// bounds keeps every sample inside the intended frame. highp so the half texel
// is representable on the 896px sheet.
const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_uv;            // sub-rect bounds u0, v0, u1, v1
uniform vec2 u_half;          // half a texel in uv space
uniform float u_alpha;        // whole-sprite opacity (fading map objects)
void main() {
  vec2 uv = clamp(v_uv, u_uv.xy + u_half, u_uv.zw - u_half);
  vec4 c = texture2D(u_tex, uv);
  gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class SpriteRenderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("WebGL is not available in this browser");
    this.gl = gl;
    this.canvas = canvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("program: " + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    this.a_xy = gl.getAttribLocation(prog, "a_xy");
    this.u_uv = gl.getUniformLocation(prog, "u_uv");
    this.u_half = gl.getUniformLocation(prog, "u_half");
    this.u_dst = gl.getUniformLocation(prog, "u_dst");
    this.u_canvas = gl.getUniformLocation(prog, "u_canvas");
    this.u_tex = gl.getUniformLocation(prog, "u_tex");
    this.u_alpha = gl.getUniformLocation(prog, "u_alpha");

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.textures = new Map(); // url -> { tex, w, h, ready }
  }

  loadTexture(url) {
    const cached = this.textures.get(url);
    if (cached) return cached;

    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const entry = { tex, w: 1, h: 1, ready: false };
    this.textures.set(url, entry);

    const img = new Image();
    // Settles once the image is usable or has failed; a missing asset must not
    // hold up whoever waits for a room to load.
    entry.loaded = new Promise((resolve) => {
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        entry.w = img.width;
        entry.h = img.height;
        entry.ready = true;
        resolve();
      };
      img.onerror = () => resolve();
    });
    img.src = url;
    return entry;
  }

  ready(url) {
    const e = this.textures.get(url);
    return !!(e && e.ready);
  }

  setSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  begin() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.a_xy);
    gl.vertexAttribPointer(this.a_xy, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.u_tex, 0);
    gl.uniform2f(this.u_canvas, this.canvas.width, this.canvas.height);
  }

  // Draw texture sub-rect (sx,sy,sw,sh px) into dest rect (dx,dy,dw,dh px).
  drawSprite(url, sx, sy, sw, sh, dx, dy, dw, dh, alpha = 1) {
    const gl = this.gl;
    const entry = this.textures.get(url);
    if (!entry || !entry.ready) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.uniform4f(this.u_uv, sx / entry.w, sy / entry.h, (sx + sw) / entry.w, (sy + sh) / entry.h);
    gl.uniform2f(this.u_half, 0.5 / entry.w, 0.5 / entry.h);
    gl.uniform4f(this.u_dst, dx, dy, dw, dh);
    gl.uniform1f(this.u_alpha, alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Full-canvas stack of character layers: [{ url, frame:{x,y,w,h} }] bottom first.
  render(layers) {
    this.begin();
    for (const layer of layers) {
      const f = layer.frame;
      this.drawSprite(layer.url, f.x, f.y, f.w, f.h, 0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
