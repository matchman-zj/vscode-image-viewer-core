// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';

async function evaluateMember(
    session: vscode.DebugSession,
    mem_expression: string,
    frame_id: number,
    context_type: string = 'watch'
): Promise<any> {
    const result = await session.customRequest('evaluate', {
        expression: mem_expression,
        frameId: frame_id,
        context: context_type
    });
    return result.result;
}

function getWebviewContent(base64Data: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
</head>
<body>
  <h3>Debug Image Viewer (10x10)</h3>
  <canvas id="canvas" width="10" height="10" style="image-rendering: pixelated; border: 1px solid #ccc;"></canvas>

  <script>
    const base64 = "${base64Data}";
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    console.log('解码后字节数组:', bytes);

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(10, 10);
    const data = imageData.data;

    for (let i = 0; i < 100; i++) {
      const v = bytes[i] * 25; // 你设置的是 0~9，所以放大对比度
      data[i * 4 + 0] = v; // R
      data[i * 4 + 1] = v; // G
      data[i * 4 + 2] = v; // B
      data[i * 4 + 3] = 255; // A
    }

    ctx.putImageData(imageData, 0, 0);
  </script>
</body>
</html>
`;
}

function createTIFF(
    width: number,
    height: number,
    bits_per_sample: number,
    data: Uint8Array,
    filePath: string
) {
    if (bits_per_sample % 8 !== 0) {
        throw new Error('bits_per_sample must be multiple of 8');
    }
    if (data.length !== width * height * bits_per_sample / 8 * 1) {
        throw new Error('image data length not match');
    }

    const header = Buffer.alloc(32);
    header.write('II', 0, 2, 'ascii'); // Little endian
    header.writeUInt16LE(42, 2);       // TIFF magic number
    header.writeUInt32LE(32, 4);        // Offset to IFD
    header.write('image viewer by ZouJun', 8, 24, 'ascii');

    // Prepare IFD entries
    const numIFDEntries = 8;
    const ifd = Buffer.alloc(2 + numIFDEntries * 12 + 4); // 2 bytes for count, 4 bytes for nextIFD offset
    ifd.writeUInt16LE(numIFDEntries, 0); // number of IFD entries

    let offset = 2;
    function writeIFDEntry(tag: number, type: number, count: number, value: number) {
        ifd.writeUInt16LE(tag, offset);           // tag
        ifd.writeUInt16LE(type, offset + 2);      // type
        ifd.writeUInt32LE(count, offset + 4);     // count
        ifd.writeUInt32LE(value, offset + 8);     // value or offset
        offset += 12;
    }

    const imageDataOffset = header.length + ifd.length;

    writeIFDEntry(256, 4, 1, width);                    // ImageWidth
    writeIFDEntry(257, 4, 1, height);                   // ImageLength
    writeIFDEntry(258, 3, 1, bits_per_sample);          // BitsPerSample = 8
    writeIFDEntry(259, 3, 1, 1);                        // Compression = none
    writeIFDEntry(262, 3, 1, 1);                        // Photometric = BlackIsZero
    writeIFDEntry(273, 4, 1, imageDataOffset);          // StripOffsets = where image data starts
    writeIFDEntry(277, 4, 1, 1);                        // SamplesPerPixel = num of channels
    writeIFDEntry(279, 4, 1, data.length);              // StripByteCounts = length of image data

    ifd.writeUInt32LE(0, offset); // next IFD offset = 0

    const file = Buffer.concat([header, ifd, data]);
    fs.writeFileSync(filePath, file);
}

function checkConfig(view_config: vscode.WorkspaceConfiguration): boolean {
    let ret: boolean = true;
    if (view_config.get<string>("imageDataPtrName", "") === "") {
        vscode.window.showWarningMessage('imageDataPtrName is empty');
        ret = false;
    }
    if (view_config.get<string>("TempImgPath", "") === "") {
        vscode.window.showWarningMessage('TempImgPath is empty');
        ret = false;
    }
    if (view_config.get<string>("ShowImgCmd", "") === "") {
        vscode.window.showWarningMessage('ShowImgCmd is empty');
        ret = false;
    }
    return ret;
}

function formatString(template: string, values: Record<string, string>): string {
    return template.replace(/{(\w+)}/g, (_, key) =>
        key in values ? values[key] : `{${key}}`
    );
}

function formatExpression(vari_name: string, link_str: string, mem_name: string): string {
    const parts = mem_name.split("&");
    let res: string;
    if (parts.length === 2 && parts[0] === "") {
        res = `&(${vari_name}${link_str}${parts[1]})`;
    }
    else {
        res = `${vari_name}${link_str}${mem_name}`;
    }
    return res;
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function register_saveImage(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('[extension] image-viewer:save is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json
    const disposable = vscode.commands.registerCommand('image-viewer.saveImage', async (variable) => {
        // The code you place here will be executed every time your command is executed
        // Display a message box to the user
        // vscode.window.showInformationMessage('Show Image');
        if (variable === undefined) {
            vscode.window.showWarningMessage('No variable selected');
            return;
        }

        const view_config = vscode.workspace.getConfiguration("image-viewer");
        if (!checkConfig(view_config)) {
            return;
        }

        // 调试适配器协议 https://microsoft.github.io/debug-adapter-protocol/
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            vscode.window.showWarningMessage('No active debug session');
            return;
        }

        // 从调试会话中获取变量
        try {
            // 获取所有线程
            const threadsResponse = await session.customRequest('threads', {});
            const threads = threadsResponse.threads;
            if (!threads.length) {
                vscode.window.showErrorMessage('当前没有线程');
                return;
            }

            // 遍历所有线程，找一个有栈帧的线程作为当前活跃线程
            let activeThreadId: number | undefined;
            for (const thread of threads) {
                const stackTraceResponse = await session.customRequest('stackTrace', {
                    threadId: thread.id,
                    startFrame: 0,
                    levels: 1,
                });
                if (stackTraceResponse.stackFrames.length > 0) {
                    activeThreadId = thread.id;
                    break;
                }
            }

            if (!activeThreadId) {
                vscode.window.showErrorMessage('找不到活跃线程');
                return;
            }

            // 获取当前线程的栈帧
            const stackTrace = await session.customRequest('stackTrace', {
                threadId: activeThreadId
            });
            const frame_id = stackTrace.stackFrames[0].id;

            // 读取图像 宽、高、数据
            const class_name_json = view_config.get<string>("imageClassName", "");
            const class_name_map = JSON.parse(class_name_json.replace(/'/g, '"'));

            const vari_name = variable.variable.evaluateName;
            let link_str = ".";
            const vari_watch = await session.customRequest('evaluate', {
                expression: vari_name,
                frameId: frame_id,
                context: 'watch'
            });
            if (vari_watch.type in class_name_map) {
                link_str = class_name_map[vari_watch.type];
            }
            else {
                vscode.window.showErrorMessage(`未定义图像类型 ${vari_watch.type}`);
                return;
            }

            const img_data_name = view_config.get<string>("imageDataPtrName", "");
            const img_width_name = view_config.get<string>("imageWidthName", "");
            const img_height_name = view_config.get<string>("imageHeightName", "");
            const img_bits_per_pixel_name = view_config.get<string>("BitsPerPixelName", "");

            const data_memory_ref = await evaluateMember(session, formatExpression(vari_name, link_str, img_data_name), frame_id);

            let img_width = 0;
            if (img_width_name === "") {
                img_width = view_config.get<number>("defaultWidth", 0);
            }
            else {
                img_width = await evaluateMember(session, formatExpression(vari_name, link_str, img_width_name), frame_id);
            }

            let img_height = 0;
            if (img_height_name === "") {
                img_height = view_config.get<number>("defaultHeight", 0);
            }
            else {
                img_height = await evaluateMember(session, formatExpression(vari_name, link_str, img_height_name), frame_id);
            }

            let bits_per_pixel = 0;
            if (img_bits_per_pixel_name === "") {
                bits_per_pixel = view_config.get<number>("defaultBitsPerPixel", 0);
            }
            else {
                bits_per_pixel = await evaluateMember(session, formatExpression(vari_name, link_str, img_bits_per_pixel_name), frame_id);
            }
            if (bits_per_pixel % 8 !== 0 || bits_per_pixel <= 0 || bits_per_pixel > 32) {
                vscode.window.showWarningMessage('bits_per_pixel must be multiple of 8, 16, 24, 32');
                return;
            }

            const data_memory = await session.customRequest('readMemory', {
                memoryReference: data_memory_ref, // 变量地址
                offset: 0,
                count: img_width * img_height * bits_per_pixel / 8 // 你想读取多少字节
            });

            const base64_img_data = data_memory.data; // 你得到的是 base64 编码的数据
            const img_data_u8_array = Uint8Array.from(Buffer.from(base64_img_data, 'base64')); // Uint8Array 类型

            // 保存为临时tiff图像，并调用命令打开
            console.log('[extension] image-viewer get data success');
            const temp_img_path = view_config.get<string>("TempImgPath", "");
            createTIFF(img_width, img_height, bits_per_pixel, img_data_u8_array, temp_img_path);
            console.log(`[extension] image-viewer saved TIFF: ${temp_img_path}`);

            console.log('[extension] image-viewer will show image');
            await vscode.commands.executeCommand('image-viewer.showImage', {});

        } catch (err) {
            vscode.window.showErrorMessage(`Evaluate error: ${err}`);
        }
    });

    context.subscriptions.push(disposable);
}

