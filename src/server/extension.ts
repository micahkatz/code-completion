import * as vscode from 'vscode';
import * as fs from 'fs';
import { OPENAI_API_KEY } from './secret';
import typescriptDocs from './lang-docs/typescript';
import javascriptDocs from './lang-docs/javascript';
import pythonDocs from './lang-docs/python';

export async function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'code-completion.webview',
            new ReactAppWebView(context)
        )
    );
}
// a function to get the code for the current active file
const getCurrentEditorCode = () => {
    const editor = vscode.window.activeTextEditor;

    if (editor) {
        let document = editor.document;

        return `Here is the context of the current file (${document.fileName})

        ${document.getText()}`;
    }
    // the LLM will get this error message if no editor is open
    return 'Here is the context of the current file: There is no file editor open';
};

// a function to get the language docs for a specific language
const getCurrentEditorLanguageDocs = () => {
    const editor = vscode.window.activeTextEditor;

    if (editor) {
        const { fileName } = editor.document;
        if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
            return typescriptDocs;
        }
        if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) {
            return javascriptDocs;
        }
        if (fileName.endsWith('.py')) {
            return pythonDocs;
        }
    }

    return null;
};

// an async function to invoke GPT-3.5 Turbo via an API call
const llmInvoke = async (messages: [], prompt: string) => {
    const headers = new Headers();
    headers.append('Content-Type', 'application/json');
    headers.append('Authorization', `Bearer ${OPENAI_API_KEY}`);
    const currentEditorLanguageDocs = getCurrentEditorLanguageDocs();

    // get the language for the current file and insert docs for the language if applicable
    const langDocsSystemMessage = currentEditorLanguageDocs
        ? [
              {
                  role: 'system',
                  content: currentEditorLanguageDocs,
              },
          ]
        : [];
    const currentEditorCode = getCurrentEditorCode();
    const MAX_CODE_LEN = 5000;

    const requestOptions = {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant.',
                },
                ...messages,
                ...langDocsSystemMessage,
                {
                    role: 'system',
                    content:
                        currentEditorCode.length > MAX_CODE_LEN
                            ? `${currentEditorCode.slice(
                                  0,
                                  MAX_CODE_LEN
                              )}\n\nOUTPUT HAS BEEN TRUNCATED BECAUSE OF LARGE FILE SIZE`
                            : currentEditorCode,
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        }),
    };
    try {
        const response = await fetch(
            'https://api.openai.com/v1/chat/completions',
            requestOptions
        );
        type OpenAiResponse = {
            id: string;
            object: string;
            created: number;
            model: string;
            choices: {
                index: number;
                message: {
                    role: string;
                    content: string;
                };
                logprobs: null;
                finish_reason: string;
            }[];
            usage: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
            };
            system_fingerprint: null;
        };
        const resJson = await response.json();
        if (resJson?.error) {
            throw resJson.error;
        }
        const res = resJson as OpenAiResponse;
        return res?.choices[0]?.message?.content;
    } catch (err) {
        console.error(err);
        return 'There was a server error';
    }
};

export class ReactAppWebView implements vscode.WebviewViewProvider {
    constructor(private context: vscode.ExtensionContext) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        webviewView.webview.options = {
            enableScripts: true,
        };
        // get the script for the React app from the build output
        let scriptSrc = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                'src',
                'client',
                'dist',
                'index.js'
            )
        );
        // get the CSS for the React app from the build output
        let cssSrc = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                'src',
                'client',
                'dist',
                'index.css'
            )
        );

        // create a webview that has the react app's script and styles
        webviewView.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <link rel="stylesheet" href="${cssSrc}" />
            </head>
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <div id="root"></div>
                <script src="${scriptSrc}"></script>
            </body>
            </html>
        `;

        // handle communication from the React App
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    // a new chat message has been sent from the React app
                    case 'chat-newMessage-human':
                        const llmResponse = await llmInvoke(
                            message.messages,
                            message.prompt
                        );
                        // send back response to the React App
                        webviewView.webview.postMessage({
                            command: 'chat-newMesssage',
                            text: llmResponse,
                        });
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }
}

export function deactivate() {}
