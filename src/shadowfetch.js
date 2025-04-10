import { connect } from "cloudflare:sockets";

// 全局配置，仅保留调试模式标志
const CONFIG = {
  DEBUG_MODE: false,
};

// 从环境变量更新全局配置（优先使用环境变量中的值）
function updateConfigFromEnv(env) {
  if (!env) return;
  for (const key of Object.keys(CONFIG)) {
    if (key in env) {
      if (typeof CONFIG[key] === 'boolean') {
        CONFIG[key] = env[key] === 'true';
      } else {
        CONFIG[key] = env[key];
      }
    }
  }
}

// 定义文本编码器和解码器，用于在字符串和字节数组之间转换
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 过滤掉不应转发的 HTTP 头部（忽略 host、accept-encoding 和 cf-* 开头的头部）
const HEADER_FILTER_RE = /^(host|accept-encoding|cf-)/i;

// 根据调试模式设置定义调试日志输出函数
const log = CONFIG.DEBUG_MODE
  ? (message, data = "") => console.log(`[DEBUG] ${message}`, data)
  : () => {};

// 将多个 Uint8Array 连接成一个新的 Uint8Array
function concatUint8Arrays(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// 解析 HTTP 响应头，返回状态码、状态文本、头部和头部部分的结束位置
function parseHttpHeaders(buff) {
  const text = decoder.decode(buff);
  // 查找 HTTP 头部结束标记 "\r\n\r\n"
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerSection = text.slice(0, headerEnd).split("\r\n");
  const statusLine = headerSection[0];
  // 匹配 HTTP 状态行，例如 "HTTP/1.1 200 OK"
  const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
  if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
  const headers = new Headers();
  // 解析响应头
  for (let i = 1; i < headerSection.length; i++) {
    const line = headerSection[i];
    const idx = line.indexOf(": ");
    if (idx !== -1) {
      headers.append(line.slice(0, idx), line.slice(idx + 2));
    }
  }
  return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
}

// 从读取器中读取数据，直到遇到双 CRLF（表示 HTTP 头部结束）
async function readUntilDoubleCRLF(reader) {
  let respText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      respText += decoder.decode(value, { stream: true });
      if (respText.includes("\r\n\r\n")) break;
    }
    if (done) break;
  }
  return respText;
}

// 异步生成器：读取分块 HTTP 响应数据块并按顺序生成每个块
async function* readChunks(reader, buff = new Uint8Array()) {
  while (true) {
    // 在现有缓冲区中查找 CRLF 分隔符的位置
    let pos = -1;
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i + 1] === 10) {
        pos = i;
        break;
      }
    }
    // 如果未找到，继续读取更多数据以填充缓冲区
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buff = concatUint8Arrays(buff, value);
      continue;
    }
    // 解析块大小（十六进制格式）
    const size = parseInt(decoder.decode(buff.slice(0, pos)), 16);
    log("Read chunk size", size);
    // 大小为 0 表示块结束
    if (!size) break;
    // 从缓冲区中移除已解析的大小部分和后面的 CRLF
    buff = buff.slice(pos + 2);
    // 确保缓冲区包含完整的块（包括尾部的 CRLF）
    while (buff.length < size + 2) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Unexpected EOF in chunked encoding");
      buff = concatUint8Arrays(buff, value);
    }
    // 生成块数据（不包括尾部的 CRLF）
    yield buff.slice(0, size);
    buff = buff.slice(size + 2);
  }
}

// 解析完整的 HTTP 响应，根据传输模式（分块或固定长度）处理响应体数据
async function parseResponse(reader) {
  let buff = new Uint8Array();
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buff = concatUint8Arrays(buff, value);
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        const isChunked = headers.get("transfer-encoding")?.includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        const data = buff.slice(headerEnd + 4);
        // 通过 ReadableStream 分发响应体数据
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                if (isChunked) {
                  log("Using chunked transfer mode");
                  // 分块传输模式：按顺序读取并排队每个块
                  for await (const chunk of readChunks(reader, data)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
                  log("Using fixed-length transfer mode", { contentLength });
                  let received = data.length;
                  if (data.length) ctrl.enqueue(data);
                  // 固定长度模式：根据 content-length 读取指定字节数
                  while (received < contentLength) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    received += value.length;
                    ctrl.enqueue(value);
                  }
                }
                ctrl.close();
              } catch (err) {
                log("Error parsing response", err);
                ctrl.error(err);
              }
            },
          }),
          { status, statusText, headers }
        );
      }
    }
    if (done) break;
  }
  throw new Error("Unable to parse response headers");
}

// 生成 WebSocket 握手所需的随机 Sec-WebSocket-Key
function generateWebSocketKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// 将文本消息打包成 WebSocket 帧（目前仅支持不太大的文本帧）
function packTextFrame(payload) {
  const FIN_AND_OP = 0x81; // FIN 标志和文本帧操作码
  const maskBit = 0x80; // 掩码位（客户端发送的消息必须设置为 1）
  const len = payload.length;
  let header;
  if (len < 126) {
    header = new Uint8Array(2);
    header[0] = FIN_AND_OP;
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = new Uint8Array(4);
    header[0] = FIN_AND_OP;
    header[1] = maskBit | 126;
    header[2] = (len >> 8) & 0xff;
    header[3] = len & 0xff;
  } else {
    throw new Error("Payload too large");
  }
  // 生成 4 字节随机掩码
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const maskedPayload = new Uint8Array(len);
  // 将掩码应用于负载
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ mask[i % 4];
  }
  // 连接帧头、掩码和掩码负载
  return concatUint8Arrays(header, mask, maskedPayload);
}

// 用于解析和重新组装 WebSocket 帧的类，支持分片消息
class SocketFramesReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array();
    this.fragmentedPayload = null;
    this.fragmentedOpcode = null;
  }
  // 确保缓冲区有足够的字节用于解析
  async ensureBuffer(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.reader.read();
      if (done) return false;
      this.buffer = concatUint8Arrays(this.buffer, value);
    }
    return true;
  }
  // 解析下一个 WebSocket 帧并处理分片（操作码 0 表示继续）
  async nextFrame() {
    while (true) {
      if (!(await this.ensureBuffer(2))) return null;
      const first = this.buffer[0],
        second = this.buffer[1],
        fin = (first >> 7) & 1,
        opcode = first & 0x0f,
        isMasked = (second >> 7) & 1;
      let payloadLen = second & 0x7f,
        offset = 2;
      // 如果负载长度为 126，解析接下来的两个字节获取实际长度
      if (payloadLen === 126) {
        if (!(await this.ensureBuffer(offset + 2))) return null;
        payloadLen = (this.buffer[offset] << 8) | this.buffer[offset + 1];
        offset += 2;
      } else if (payloadLen === 127) {
        throw new Error("127 length mode is not supported");
      }
      let mask;
      if (isMasked) {
        if (!(await this.ensureBuffer(offset + 4))) return null;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (!(await this.ensureBuffer(offset + payloadLen))) return null;
      let payload = this.buffer.slice(offset, offset + payloadLen);
      if (isMasked && mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      // 从缓冲区中移除已处理的字节
      this.buffer = this.buffer.slice(offset + payloadLen);
      // 操作码 0 表示继续帧：连接分片数据
      if (opcode === 0) {
        if (this.fragmentedPayload === null)
          throw new Error("Received continuation frame without initiation");
        this.fragmentedPayload = concatUint8Arrays(this.fragmentedPayload, payload);
        if (fin) {
          const completePayload = this.fragmentedPayload;
          const completeOpcode = this.fragmentedOpcode;
          this.fragmentedPayload = this.fragmentedOpcode = null;
          return { fin: true, opcode: completeOpcode, payload: completePayload };
        }
      } else {
        // 如果有分片数据但当前帧不是继续帧，重置分片状态
        if (!fin) {
          this.fragmentedPayload = payload;
          this.fragmentedOpcode = opcode;
          continue;
        } else {
          if (this.fragmentedPayload) {
            this.fragmentedPayload = this.fragmentedOpcode = null;
          }
          return { fin, opcode, payload };
        }
      }
    }
  }
}

// 根据请求类型转发 HTTP 请求或 WebSocket 握手和数据
async function nativeFetch(req, dstUrl) {
  // 通过移除匹配过滤条件的头部来清理头部
  const cleanedHeaders = new Headers();
  for (const [k, v] of req.headers) {
    if (!HEADER_FILTER_RE.test(k)) {
      cleanedHeaders.set(k, v);
    }
  }
  
  // 检查请求是否为 WebSocket 请求
  const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
  const isWebSocket = upgradeHeader === "websocket";
  const targetUrl = new URL(dstUrl);
  
  if (isWebSocket) {
    // 如果目标 URL 不支持 WebSocket 协议，返回错误响应
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    // 建立与目标服务器的原始套接字连接
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: isSecure ? "on" : "off" }
    );
  
    // 生成 WebSocket 握手所需的密钥
    const key = generateWebSocketKey();

    // 构建握手所需的 HTTP 头部
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
    // 组装 WebSocket 握手的 HTTP 请求数据
    const handshakeReq =
      `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n';

    log("Sending WebSocket handshake request", handshakeReq);
    const writer = socket.writable.getWriter();
    await writer.write(encoder.encode(handshakeReq));
  
    const reader = socket.readable.getReader();
    const handshakeResp = await readUntilDoubleCRLF(reader);
    log("Received handshake response", handshakeResp);
    // 验证握手响应是否指示 101 切换协议状态
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    // 创建内部 WebSocketPair
    const [client, server] = new WebSocketPair();
    client.accept();
    // 在客户端和远程套接字之间建立双向帧中继
    relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  } else {
    // 对于标准 HTTP 请求：设置必要的头部（如 Host 和禁用压缩）
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    const port = targetUrl.protocol === "https:" ? 443 : 80;
    const socket = await connect(
      { hostname: targetUrl.hostname, port },
      { secureTransport: targetUrl.protocol === "https:" ? "on" : "off" }
    );
    const writer = socket.writable.getWriter();
    // 构建请求行和头部
    const requestLine =
      `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    log("Sending request", requestLine);
    await writer.write(encoder.encode(requestLine));
  
    // 如果有请求体，将其转发到目标服务器
    if (req.body) {
      log("Forwarding request body");
      for await (const chunk of req.body) {
        await writer.write(chunk);
      }
    }
    // 解析并返回目标服务器的响应
    return await parseResponse(socket.readable.getReader());
  }
}

// 在客户端和远程套接字之间双向中继 WebSocket 帧
function relayWebSocketFrames(ws, socket, writer, reader) {
  // 监听来自客户端的消息，将其打包成帧，并发送到远程套接字
  ws.addEventListener("message", async (event) => {
    let payload;
    if (typeof event.data === "string") {
      payload = encoder.encode(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      payload = new Uint8Array(event.data);
    } else {
      payload = event.data;
    }
    const frame = packTextFrame(payload);
    try {
      await writer.write(frame);
    } catch (e) {
      log("Remote write error", e);
    }
  });
  
  // 异步中继从远程接收到的 WebSocket 帧到客户端
  (async function relayFrames() {
    const frameReader = new SocketFramesReader(reader);
    try {
      while (true) {
        const frame = await frameReader.nextFrame();
        if (!frame) break;
        // 根据操作码处理数据帧
        switch (frame.opcode) {
          case 1: // 文本帧
          case 2: // 二进制帧
            ws.send(frame.payload);
            break;
          case 8: // 关闭帧
            log("Received Close frame, closing WebSocket");
            ws.close(1000);
            return;
          default:
            log(`Received unknown frame type, Opcode: ${frame.opcode}`);
        }
      }
    } catch (e) {
      log("Error reading remote frame", e);
    } finally {
      ws.close();
      writer.releaseLock();
      socket.close();
    }
  })();
  
  // 当客户端 WebSocket 关闭时，也关闭远程套接字连接
  ws.addEventListener("close", () => socket.close());
}

// 请求处理的入口点：更新配置并转发请求
async function handleRequest(req, dstUrl, env) {
  updateConfigFromEnv(env);
  CONFIG.DEBUG_MODE = CONFIG.DEBUG_MODE;
  log("Target URL", dstUrl);
  
  return await nativeFetch(req, dstUrl);
}

// 导出 fetch 函数供其他模块使用
export { handleRequest };
