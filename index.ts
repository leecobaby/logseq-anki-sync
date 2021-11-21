import '@logseq/libs'
import { LSPluginBaseInfo } from '@logseq/libs/dist/libs'
import * as AnkiConnect from './AnkiConnect';
import * as AnkiConnectExtended from './AnkiConnectExtended';
import { AnkiCardTemplates } from './templates/AnkiCardTemplates';
import { Remarkable } from 'remarkable';
import path from "path";
import { decodeHTMLEntities, string_to_arr, get_math_inside_md } from './utils';

const delay = (t = 100) => new Promise(r => setTimeout(r, t))

// --- Register UI Elements Onload ---
function main(baseInfo: LSPluginBaseInfo) {
  let syncing = false;

  logseq.provideModel({
    async syncLogseqToAnkiWrapper() { // Wrapper function for error handling
      if (syncing) { console.log(`Syncing already in process...`); return; }
      syncing = true;

      try {
        await syncLogseqToAnki();
      } catch (e) {
        logseq.App.showMsg(e.toString(), 'warning')
        console.error(e);
      } finally {
        syncing = false;
      }
    }
  });

  logseq.App.registerUIItem('toolbar', {
    key: 'logseq-anki',
    template: `
      <a data-on-click="syncLogseqToAnkiWrapper"
         class="button">
        <i class="ti ti-play-card"></i>
      </a>
    `
  });
}

// Bootstrap
logseq.ready(main).catch(console.error)

// --- Main Functions ---
async function syncLogseqToAnki() {
  let backup = logseq.baseInfo.settings.backup || false;
  let graphName = (await logseq.App.getCurrentGraph()).name;
  logseq.App.showMsg(`Starting Logseq to Anki Sync for graph ${graphName}`);
  console.log(`Starting Logseq to Anki Sync for graph ${graphName}`);

  // -Request Access-
  await AnkiConnect.requestPermission();

  // -- Create backup of Anki --
  try { if (backup) await AnkiConnect.createBackup(); } catch (e) { console.error(e); }

  // -Create models if it doesn't exists-
  await AnkiConnect.createModel(`${graphName}Model`, ["uuid", "Text", "Extra", "Breadcrumb", "Config", "Tobedefinedlater", "Tobedefinedlater2"], AnkiCardTemplates.frontTemplate, AnkiCardTemplates.backTemplate);

  // -- Find blocks for which anki notes are to be created --
  let blocks = await logseq.DB.datascriptQuery(`
  [:find (pull ?b  [*])
  :where
    [?b :block/properties ?p]
    [(get ?p :ankicloze) ?t]
  ]`);
  blocks = await Promise.all(blocks.map(async (block) => {
    if(!block[0].properties["id"]) await logseq.Editor.upsertBlockProperty(block[0].uuid["$uuid$"], "id", block[0].uuid["$uuid$"]); // Force persistence of uuid after re-index by writing in file
    let page =  (block[0].page) ? await logseq.Editor.getPage(block[0].page.id) : {};
    return { ...(await logseq.Editor.getBlock(block[0].uuid["$uuid$"])), ankiId: await AnkiConnectExtended.getAnkiIDForModelFromUUID(block[0].uuid["$uuid$"], `${graphName}Model`), page: page };
  }));
  console.log("Blocks:", blocks);

  // -- Declare some variables to keep track of different operations performed --
  let created, updated, deleted, failedCreated, failedUpdated, failedDeleted: number;
  created = updated = deleted = failedCreated = failedUpdated = failedDeleted = 0;
  let failedCreatedArr, failedUpdatedArr: any;
  failedCreatedArr = []; failedUpdatedArr = [];

  // --Add or update cards in anki--
  for (let block of blocks) {
    if (block.ankiId == null || isNaN(block.ankiId)) {
      try {
        let anki_html = await addClozesToMdAndConvertToHtml(block.content, `${block.properties.ankicloze}`);
        let deck: any = (block.page.hasOwnProperty("properties") && block.page.properties.hasOwnProperty("deck")) ? block.page.properties.deck : "Default";
        let breadcrumb_html = `<a href="#">${block.page.originalName}</a>`;
        let tags = (block.page.hasOwnProperty("properties") && block.page.properties.hasOwnProperty("tags")) ? block.page.properties.tags : [];
        block.ankiId = await AnkiConnect.addNote(block.uuid, deck, `${graphName}Model`, { "uuid": block.uuid, "Text": anki_html, "Extra": "", "Breadcrumb": breadcrumb_html }, tags);
        console.log(`Added note with uuid ${block.uuid}`);
        created++;
      } catch (e) { console.error(e); failedCreated++; failedCreatedArr.push(block); }
    }
    else {
      try {
        let anki_html = await addClozesToMdAndConvertToHtml(block.content, `${block.properties.ankicloze}`);
        let deck: any = (block.page.hasOwnProperty("properties") && block.page.properties.hasOwnProperty("deck")) ? block.page.properties.deck : "Default";
        let breadcrumb_html = `<a href="#">${block.page.originalName}</a>`;
        let tags = (block.page.hasOwnProperty("properties") && block.page.properties.hasOwnProperty("tags")) ? block.page.properties.tags : [];
        await AnkiConnect.updateNote(block.ankiId, deck, `${graphName}Model`, { "uuid": block.uuid, "Text": anki_html, "Extra": "", "Breadcrumb": breadcrumb_html }, tags);
        console.log(`Updated note with uuid ${block.uuid}`);
        updated++;
      } catch (e) { console.error(e); failedUpdated++; failedUpdatedArr.push(block); }
    }
  }

  // --Delete the deleted cards--
  await AnkiConnect.invoke("reloadCollection", {});
  // Get Anki Notes made from this logseq graph
  let q = await AnkiConnect.query(`note:${graphName}Model`)
  let ankiNoteIds: number[] = q.map(i => parseInt(i));
  console.log(ankiNoteIds);
  // Flatten curren logseq block's anki ids
  let blockAnkiIds: number[] = blocks.map(block => parseInt(block.ankiId));
  console.log(blockAnkiIds);
  // Delete anki notes created by app which are no longer in logseq graph
  for (let ankiNoteId of ankiNoteIds) {
    if (!blockAnkiIds.includes(ankiNoteId)) {
      try {
        await AnkiConnect.deteteNote(ankiNoteId);
        console.log(`Deleted note with ankiId ${ankiNoteId}`);
        deleted++;
      } catch (e) { console.error(e); failedDeleted++; }
    }
  }

  // --Update Anki and show summery in logseq--
  await AnkiConnect.invoke("removeEmptyNotes", {});
  await AnkiConnect.invoke("reloadCollection", {});
  let summery = `Sync Completed! Created Blocks: ${created} Updated Blocks: ${updated} Deleted Blocks: ${deleted} `;
  let status = 'success';
  if (failedCreated > 0) summery += `Failed Created Blocks: ${failedCreated} `;
  if (failedUpdated > 0) summery += `Failed Updated Blocks: ${failedUpdated} `;
  if (failedDeleted > 0) summery += `Failed Deleted Blocks: ${failedDeleted} `;
  if (failedCreated > 0 || failedUpdated > 0 || failedDeleted > 0) status = 'warning';
  logseq.App.showMsg(summery, status);
  console.log(summery);
  if (failedCreated > 0) console.log("failedCreatedArr:", failedCreatedArr);
  if (failedUpdated > 0) console.log("failedUpdatedArr:", failedUpdatedArr);
}

async function addClozesToMdAndConvertToHtml(text: string, regexArr: any): Promise<string> {
  let res = text;
  res = res.replace(/^\s*(\w|-)*::.*/gm, "");  //Remove properties

  console.log(regexArr);
  regexArr = string_to_arr(regexArr);
  console.log(regexArr);
  // Get list of math clozes
  let math = get_math_inside_md(res);
  for (let [i, reg] of regexArr.entries()) {
    if (typeof reg == "string")
      //@ts-expect-error
      res = res.replaceAll(reg.trim(), (match) => {
        if (math.find(math =>math.includes(match)))
          return `{{c${i + 1}::${match.replace(/}}/g,"} } ")} }}`;
        else
          return `{{c${i + 1}::${match}}}`;
      });
    else
      res = res.replace(reg, (match) => {
        if (math.find(math =>math.includes(match)))
          return `{{c${i + 1}::${match.replace(/}}/g,"} } ")} }}`;
        else
          return `{{c${i + 1}::${match}}}`;
      });
  }

  res = res.replace(/(?<!\$)\$((?=[\S])(?=[^$])[\s\S]*?\S)\$/g, "\\( $1 \\)"); // Convert inline math
  res = res.replace(/\$\$([\s\S]*?)\$\$/g, "\\[ $1 \\]"); // Convert block math
  res = res.replace(/#\+BEGIN_(INFO|PROOF)( .*)?\n((.|\n)*?)#\+END_\1/gi, function(match, g1, g2, g3) { // Remove proof, info org blocks
    return ``; 
  }); 
    res = res.replace(/#\+BEGIN_(QUOTE)( .*)?\n((.|\n)*?)#\+END_\1/gi, function(match, g1, g2, g3) { // Convert quote org blocks
    return `<blockquote">${g3.trim()}</blockquote>`;
  });
  res = res.replace(/#\+BEGIN_(CENTER)( .*)?\n((.|\n)*?)#\+END_\1/gi, function(match, g1, g2, g3) { // Convert center org blocks
    return `<span class="text-center">${g3.trim()}</span>`; // div is buggy with remarkable
  });
  res = res.replace(/#\+BEGIN_(COMMENT)( .*)?\n((.|\n)*?)#\+END_\1/gi, function(match, g1, g2, g3) { // Remove comment org blocks
    return ``; 
  }); 
  res = res.replace(/#\+BEGIN_(\w+)( .*)?\n((.|\n)*?)#\+END_\1/gi, function(match, g1, g2, g3) { // Convert named org blocks
    return `<span class="${g1.toLowerCase()}">${g3.trim()}</span>`; // div is buggy with remarkable
  }); 

  res = res.replace(/\\/gi, "\\\\"); //Fix blackkslashes
  let remarkable = new Remarkable('full', {
    html: true,
    breaks: true,
    typographer: false,
  });
  remarkable.inline.ruler.disable(['sub', 'sup', 'ins']);
  remarkable.block.ruler.disable(['code']);
  const originalLinkValidator = remarkable.inline.validateLink;
  const dataLinkRegex = /^\s*data:([a-z]+\/[a-z]+(;[a-z-]+=[a-z-]+)?)?(;base64)?,[a-z0-9!$&',()*+,;=\-._~:@/?%\s]*\s*$/i;
  const isImage = /^.*\.(png|jpg|jpeg|bmp|tiff|gif|apng|svg|webp)$/i;
  const isWebURL = /^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/i;
  remarkable.inline.validateLink = (url: string) => originalLinkValidator(url) || encodeURI(url).match(dataLinkRegex) || (encodeURI(url).match(isImage) && !encodeURI(url).match(isWebURL));
  const originalImageRender = remarkable.renderer.rules.image;
  let graphPath = (await logseq.App.getCurrentGraph()).path;
  remarkable.renderer.rules.image = (...a) => {
    if ((encodeURI(a[0][a[1]].src).match(isImage) && !encodeURI(a[0][a[1]].src).match(isWebURL))) { // Image is relative to vault
      let imgPath = path.join(graphPath, a[0][a[1]].src.replace(/^(\.\.\/)+/, ""));
      AnkiConnect.storeMediaFileByPath(encodeURIComponent(a[0][a[1]].src), imgPath); // Flatten and save
      a[0][a[1]].src = encodeURIComponent(a[0][a[1]].src); // Flatten image and convert to markdown.
    }
    return originalImageRender(...a);
  };
  res = remarkable.render(res);
  res = decodeHTMLEntities(res);
  console.log(res);

  return res;
}
