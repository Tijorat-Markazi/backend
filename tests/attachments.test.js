"use strict";
/* What the assistant receives for each kind of attached file. No database and
   no network: the Anthropic sandbox is replaced by a recording stub. */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const zlib=require("node:zlib");
const {execFileSync}=require("node:child_process");
const ExcelJS=require("exceljs");
const {createReader,sniff,MAX_TEXT_CHARS,MAX_IMAGE_BYTES}=require("../srv/attachments");
const {rtfText,xmlText,workbookText,slidesText,decodeText}=require("../srv/attachment-text");

const hasUnzip=(()=>{try{execFileSync("unzip",["-v"],{stdio:"ignore"});return true;}catch{return false;}})();
const needsUnzip=hasUnzip?false:"unzip is not installed";

/* A minimal stored (uncompressed) zip, enough for unzip to read. */
function zip(files){
  const locals=[],centrals=[];let offset=0;
  for(const [name,body] of Object.entries(files)){
    const data=Buffer.from(body,"utf8"),nameBuf=Buffer.from(name,"utf8"),crc=zlib.crc32(data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBuf.length,26);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);
    central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBuf.length,28);
    central.writeUInt32LE(offset,42);
    locals.push(local,nameBuf,data);centrals.push(central,nameBuf);
    offset+=local.length+nameBuf.length+data.length;
  }
  const dir=Buffer.concat(centrals),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(centrals.length/2,8);end.writeUInt16LE(centrals.length/2,10);
  end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,dir,end]);
}
const binary=(buf,name,mime="application/octet-stream")=>({kind:"binary",name,mime,data:buf.toString("base64")});
const OLE=Buffer.from([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1,0,0,0,0,0,0,0,0]);
const PNG=Buffer.from("89504e470d0a1a0a0000000d49484452","hex");

function setup(sandboxText=null){
  const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),"attach-test-"));
  const calls=[];
  const read=createReader({tmpDir,readInSandbox:async file=>{calls.push(file);return sandboxText;}});
  return {read,calls,tmpDir};
}

test("sniffs formats from their bytes, not their names",()=>{
  assert.equal(sniff(Buffer.from("%PDF-1.7\n")),"pdf");
  assert.equal(sniff(PNG),"image/png");
  assert.equal(sniff(Buffer.from([0xFF,0xD8,0xFF,0xE0])),"image/jpeg");
  assert.equal(sniff(Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WEBPVP8 ")])),"image/webp");
  assert.equal(sniff(zip({"a.txt":"x"})),"zip");
  assert.equal(sniff(Buffer.from("{\\rtf1\\ansi hello}")),"rtf");
  assert.equal(sniff(Buffer.from("const a = 1;\n// Ş ö ğ\n")),"text");
  assert.equal(sniff(OLE),"other");
});

test("a picture Claude can see becomes an image block with its real type",async()=>{
  const {read,calls}=setup();
  const part=await read(binary(PNG,"photo.jpg","image/jpeg"));
  assert.deepEqual(part.media,{mime:"image/png",data:PNG.toString("base64")});
  assert.equal(calls.length,0);
});

test("a PDF becomes a document block whatever its name",async()=>{
  const {read}=setup();
  const pdf=Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n");
  const part=await read(binary(pdf,"hisobot"));
  assert.deepEqual(part.media,{mime:"application/pdf",data:pdf.toString("base64")});
});

test("any plain-text file is read as text, whatever its extension",async()=>{
  const {read,calls}=setup();
  const part=await read(binary(Buffer.from("SELECT * FROM orgs;\n-- Ş ö"),"query.sql"));
  assert.match(part.text,/SELECT \* FROM orgs;/);
  assert.match(part.text,/Ş ö/);
  assert.equal(calls.length,0);
});

test("UTF-16 text with a byte-order mark is decoded",async()=>{
  const {read}=setup();
  const utf16=Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from("Salom dunyo","utf16le")]);
  assert.equal((await read(binary(utf16,"notes.txt"))).text,"Salom dunyo");
});

test("a .docx is read through its XML, words split across runs kept whole",{skip:needsUnzip},async()=>{
  const {read,calls}=setup();
  const docx=zip({
    "[Content_Types].xml":"<Types/>",
    "word/document.xml":"<w:document><w:body><w:p><w:r><w:t>Tijorat </w:t></w:r><w:r><w:t>Mar</w:t></w:r><w:r><w:t>kazi</w:t></w:r></w:p><w:p><w:r><w:t>Narx &amp; sotuv</w:t></w:r></w:p></w:body></w:document>",
  });
  const part=await read(binary(docx,"hisobot.docx"));
  assert.equal(part.text,"Tijorat Markazi\nNarx & sotuv");
  assert.equal(calls.length,0);
});

test("a .pptx lists its slides in numeric order",{skip:needsUnzip},async()=>{
  const {read}=setup();
  const slide=t=>`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const pptx=zip({"ppt/slides/slide10.xml":slide("Ten"),"ppt/slides/slide2.xml":slide("Two"),"ppt/slides/slide1.xml":slide("One")});
  const text=(await read(binary(pptx,"deck.pptx"))).text;
  assert.ok(text.indexOf("One")<text.indexOf("Two")&&text.indexOf("Two")<text.indexOf("Ten"),text);
  assert.match(text,/slide 3/i);
});

test("an .xlsx gives each sheet by name, with shared strings resolved",{skip:needsUnzip},async()=>{
  const {read}=setup();
  const book=new ExcelJS.Workbook();
  const sales=book.addWorksheet("Sotuv");
  sales.addRow(["Mahsulot","Narx"]);sales.addRow(["Stol",250000]);
  book.addWorksheet("Xodimlar").addRow(["Ism"]);
  const xlsx=Buffer.from(await book.xlsx.writeBuffer());
  const text=(await read(binary(xlsx,"jadval.xlsx"))).text;
  assert.match(text,/--- Sotuv ---\nMahsulot\tNarx\nStol\t250000/);
  assert.match(text,/--- Xodimlar ---\nIsm/);
});

test("an OpenDocument text file is read from content.xml",{skip:needsUnzip},async()=>{
  const {read}=setup();
  const odt=zip({mimetype:"application/vnd.oasis.opendocument.text",
    "content.xml":"<office:document-content><text:p>Birinçi<text:s/>qator</text:p><text:p>Ikkinçi</text:p></office:document-content>"});
  assert.equal((await read(binary(odt,"xat.odt"))).text,"Birinçi qator\nIkkinçi");
});

test("a legacy .doc goes to the sandbox with its bytes, name and type",async()=>{
  const {read,calls}=setup("Hujjat matni");
  const part=await read(binary(OLE,"talim-al9qyf.doc","application/msword"));
  assert.equal(part.text,"Hujjat matni");
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,"talim-al9qyf.doc");
  assert.equal(calls[0].mime,"application/msword");
  assert.ok(Buffer.isBuffer(calls[0].data)&&calls[0].data.equals(OLE));
});

test("a zip that is not a document also goes to the sandbox",{skip:needsUnzip},async()=>{
  const {read,calls}=setup("archive listing");
  assert.equal((await read(binary(zip({"photos/a.bin":"\u0000\u0001"}),"arxiv.zip"))).text,"archive listing");
  assert.equal(calls.length,1);
});

test("a picture Claude cannot take (HEIC) is not sent as an image block",async()=>{
  const {read,calls}=setup(null);
  const heic=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from("ftypheic"),Buffer.alloc(8)]);
  const part=await read(binary(heic,"IMG_0001.HEIC","image/heic"));
  assert.equal(part.media,null);
  assert.equal(calls.length,1);
  assert.match(part.text,/could not be read/i);
});

test("an RTF file is read without its control words",async()=>{
  const {read,calls}=setup();
  const rtf="{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0 Times;}}{\\*\\generator Word;}\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par Tijorat \\u350?irkat\\tab 2026}";
  const part=await read(binary(Buffer.from(rtf,"latin1"),"xat.rtf"));
  assert.equal(part.text,"Привет\nTijorat Şirkat\t2026");
  assert.equal(calls.length,0);
});

test("text past the limit is cut with a note saying so",async()=>{
  const {read}=setup();
  const part=await read({kind:"text",name:"big.csv",content:"x".repeat(MAX_TEXT_CHARS+50)});
  assert.ok(part.text.startsWith("x".repeat(MAX_TEXT_CHARS)));
  assert.match(part.text,/only the first/i);
});

test("a damaged or empty upload is reported, not passed on",async()=>{
  const {read,calls}=setup();
  for(const bad of [{kind:"binary",name:"a.doc",data:"%%%not base64%%%"},{kind:"binary",name:"a.doc",data:""},{kind:"weird"},null]){
    const part=await read(bad);
    assert.equal(part.media,null);
    assert.match(part.text,/damaged|empty/i);
  }
  assert.equal(calls.length,0);
});

test("the temporary copy of a zip is removed afterwards",{skip:needsUnzip},async()=>{
  const {read,tmpDir}=setup();
  await read(binary(zip({"word/document.xml":"<w:p><w:t>a</w:t></w:p>"}),"a.docx"));
  assert.deepEqual(fs.readdirSync(tmpDir),[]);
});

test("xmlText decodes numeric entities and keeps table cells apart",()=>{
  assert.equal(xmlText("<w:p><w:t>&#350;irkat &#x2014; 5&lt;6</w:t></w:p>"),"Şirkat — 5<6");
  assert.equal(xmlText("<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>"),"A\nB");
  assert.equal(rtfText("{\\rtf1 a\\~b}"),"a b");
});

/* ---------- hostile and awkward input ---------- */
const fast=(label,fn,ms=1500)=>{const t=Date.now();fn();const took=Date.now()-t;assert.ok(took<ms,label+" took "+took+" ms");};

test("crafted markup with unclosed tags is read in linear time",()=>{
  fast("w:br run",()=>xmlText("<w:br".repeat(400000)));
  fast("row run",()=>workbookText(p=>p==="xl/worksheets/sheet1.xml"?"<row><c>".repeat(300000):"",["xl/worksheets/sheet1.xml"]));
  fast("entity run",()=>xmlText("&"+"a".repeat(2000000)));
});

test("deeply nested or binary RTF stays bounded and skips \\bin data",()=>{
  fast("nesting",()=>rtfText("{\\rtf1 "+"{".repeat(1000000)+"x"));
  assert.equal(rtfText("{\\rtf1 a\\bin3 {}}b}"),"ab");
});

test("only a file that starts with %PDF- is a PDF",()=>{
  assert.equal(sniff(Buffer.from("Notes on the %PDF- header\n")),"text");
});

test("a picture over the API limit is described, not sent",async()=>{
  const {read}=setup();
  const big=Buffer.concat([PNG,Buffer.alloc(MAX_IMAGE_BYTES)]);
  const part=await read(binary(big,"scan.png","image/png"));
  assert.equal(part.media,null);
  assert.match(part.text,/larger than/i);
});

test("an .xlsx keeps empty columns in place",{skip:needsUnzip},async()=>{
  const {read}=setup();
  const book=new ExcelJS.Workbook();
  const sheet=book.addWorksheet("Jadval");
  sheet.getCell("A1").value="a";sheet.getCell("C1").value="c";
  const text=(await read(binary(Buffer.from(await book.xlsx.writeBuffer()),"t.xlsx"))).text;
  assert.match(text,/--- Jadval ---\na\t\tc/);
});

test("an empty shared string does not shift the ones after it",()=>{
  const parts={"xl/sharedStrings.xml":"<sst><si/><si><t>B</t></si></sst>",
    "xl/worksheets/sheet1.xml":'<sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData>'};
  assert.equal(workbookText(p=>parts[p]||"",["xl/worksheets/sheet1.xml"]),"--- Sheet 1 ---\nB");
});

test("slides follow the presentation's own order",()=>{
  const parts={
    "ppt/presentation.xml":'<p:presentation><p:sldIdLst><p:sldId id="1" r:id="rId9"/><p:sldId id="2" r:id="rId4"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":'<Relationships><Relationship Id="rId4" Target="slides/slide1.xml"/><Relationship Id="rId9" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml":"<a:p><a:t>One</a:t></a:p>","ppt/slides/slide2.xml":"<a:p><a:t>Two</a:t></a:p>"};
  const text=slidesText(p=>parts[p]||"",["ppt/slides/slide1.xml","ppt/slides/slide2.xml"]);
  assert.ok(text.indexOf("Two")<text.indexOf("One"),text);
});

test("Word field codes and tracked deletions are not text",()=>{
  assert.equal(xmlText('<w:p><w:r><w:instrText>HYPERLINK "http://x"</w:instrText></w:r><w:r><w:t>Sayt</w:t></w:r><w:r><w:delText>eski</w:delText></w:r></w:p>'),"Sayt");
});

test("Windows-1251 Russian text is decoded, not sent to the sandbox",async()=>{
  const {read,calls}=setup();
  const cp1251=Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2,0x20,0xec,0xe8,0xf0]);
  assert.equal(decodeText(cp1251),"Привет мир");
  assert.equal((await read(binary(cp1251,"xat.txt"))).text,"Привет мир");
  assert.equal(calls.length,0);
});

test("an empty text attachment is reported as empty",async()=>{
  const {read}=setup();
  assert.match((await read({kind:"text",name:"a.txt",content:"   "})).text,/empty/i);
});

test("without an identity the paid sandbox is never called",async()=>{
  const {read,calls}=setup("converted");
  const part=await read(binary(OLE,"a.doc"),{allowSandbox:false});
  assert.match(part.text,/could not be read/i);
  assert.equal(calls.length,0);
});

test("at most two sandbox conversions run at once",async()=>{
  const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),"attach-test-"));
  const waiting=[];
  const read=createReader({tmpDir,readInSandbox:()=>new Promise(resolve=>waiting.push(resolve))});
  const first=read(binary(OLE,"1.doc")),second=read(binary(OLE,"2.doc"));
  await new Promise(r=>setImmediate(r));
  assert.match((await read(binary(OLE,"3.doc"))).text,/busy/i);
  waiting.forEach(resolve=>resolve("ok"));
  assert.equal((await first).text,"ok");
  assert.equal((await second).text,"ok");
});

test("a zip with thousands of entries is not unpacked part by part",{skip:needsUnzip},async()=>{
  const {read,calls}=setup("handled");
  const files={};
  for(let i=1;i<=5001;i++) files["xl/worksheets/sheet"+i+".xml"]="<row/>";
  const t=Date.now();
  assert.equal((await read(binary(zip(files),"bomb.xlsx"))).text,"handled");
  assert.ok(Date.now()-t<5000);
  assert.equal(calls.length,1);
});
