import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';

async function languageFor(name, fence = false) {
  const description = fence ? LanguageDescription.matchLanguageName(languages,name,true) : LanguageDescription.matchFilename(languages,name);
  return description ? description.load() : null;
}

export async function highlightCode(element, text, name, fence = false) {
  element.textContent = text;
  const support = await languageFor(name,fence).catch(()=>null);
  if (!support || !element.isConnected || element.textContent !== text) return;
  const fragment = document.createDocumentFragment(); let end = 0;
  highlightTree(support.language.parser.parse(text),classHighlighter,(from,to,classes)=>{
    if (from > end) fragment.append(document.createTextNode(text.slice(end,from)));
    const span = document.createElement('span'); span.className = classes; span.textContent = text.slice(from,to); fragment.append(span); end = to;
  });
  if (end < text.length) fragment.append(document.createTextNode(text.slice(end)));
  element.replaceChildren(fragment);
}

export function highlightFences(root) {
  for (const element of root.querySelectorAll('pre > code')) {
    const language = [...element.classList].find(name=>name.startsWith('language-'))?.slice(9);
    if (language) void highlightCode(element,element.textContent,language,true);
  }
}

export function createCodeEditor({parent,text,filename,label,onChange,onSave,onDone}) {
  const language = new Compartment(); let destroyed = false;
  const theme = EditorView.theme({
    '&':{height:'100%',backgroundColor:'var(--app-main)',color:'var(--app-text)',fontSize:'13px'},
    '.cm-scroller':{fontFamily:'var(--mono)',lineHeight:'1.65',overflow:'auto'},
    '.cm-content':{padding:'10px 0',caretColor:'var(--app-text)'},
    '.cm-gutters':{backgroundColor:'var(--app-main)',color:'var(--app-text-tertiary)',borderRight:'1px solid var(--app-border)'},
    '.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'var(--app-fog)'},
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':{backgroundColor:'var(--editor-selection)'},
    '.cm-cursor':{borderLeftColor:'var(--app-text)'},
    '.cm-tooltip':{backgroundColor:'var(--workspace-card)',color:'var(--app-text)',border:'1px solid var(--app-border)'},
    '.cm-panels':{backgroundColor:'var(--workspace-card)',color:'var(--app-text)'},
    '.cm-searchMatch':{backgroundColor:'var(--editor-selection)'},
  });
  const view = new EditorView({parent,state:EditorState.create({doc:text,extensions:[
    basicSetup,theme,syntaxHighlighting(classHighlighter),language.of([]),
    EditorState.lineSeparator.of(text.includes('\r\n') ? '\r\n' : '\n'),
    EditorView.contentAttributes.of({'aria-label':label,'data-i18n-ignore':''}),
    keymap.of([{key:'Mod-s',run:()=>{onSave();return true;}},...(onDone ? [{key:'Mod-Enter',run:()=>{onDone();return true;}}] : []),indentWithTab]),
    EditorView.updateListener.of(update=>{if(update.docChanged)onChange(update.state.sliceDoc());}),
  ]})});
  void languageFor(filename).then(support=>{if(!destroyed&&support)view.dispatch({effects:language.reconfigure(support)});}).catch(()=>{});
  return {view,focus:()=>view.focus(),destroy(){destroyed=true;view.destroy();}};
}
