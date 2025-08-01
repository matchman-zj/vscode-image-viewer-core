import * as vscode from 'vscode';
import { register_saveImage } from './save_image';

export function activate(context: vscode.ExtensionContext) {
    const isRemote = vscode.env.remoteName !== undefined;
    console.log(`image-viewer:save activated in ${isRemote ? 'remote' : 'local'} mode`);

    // register_showImage(context);
    register_saveImage(context);
}

// This method is called when your extension is deactivated
export function deactivate() { }