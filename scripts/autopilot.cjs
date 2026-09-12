const axios = require('axios');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const sharp = require('sharp');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

const STATE_FILE = path.join(__dirname, '..', 'config', 'state.json');
const BLOG_DIR = path.join(__dirname, '..', 'src', 'content', 'blog');
const IMAGES_DIR = path.join(__dirname, '..', 'src', 'assets');

if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {}
  }
  return { postedTopics: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function createSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

async function getNextTopic() {
  const sheetCsvUrl = process.env.GOOGLE_SHEET_CSV_URL;
  const response = await axios.get(sheetCsvUrl);
  const records = parse(response.data, { columns: true, skip_empty_lines: true, trim: true });
  
  const state = loadState();
  const posted = state.postedTopics || [];

  for (const row of records) {
    const keyword = (row['Keyword (SEO Topic)'] || row.Keyword || row.keyword || row.Keywords || row.Topic || '').trim();
    if (keyword && !posted.includes(keyword.toLowerCase())) {
      return { keyword, category: row.Category || 'General' };
    }
  }
  return null;
}

async function fetchAIImage(keyword, slug) {
  const cleanKeyword = encodeURIComponent(keyword + " photorealistic, 8k, highly detailed, magazine quality");
  const url = 'https://image.pollinations.ai/prompt/' + cleanKeyword + '?width=1024&height=576&model=turbo&nologo=true';
  
  try {
    console.log("Downloading AI Image from:", url);
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    
    const fileName = slug + '.jpg';
    const filePath = path.join(IMAGES_DIR, fileName);
    
    await sharp(Buffer.from(imgRes.data))
      .jpeg({ quality: 90 })
      .toFile(filePath);
      
    return '../../assets/' + fileName; 
  } catch (e) {
    console.error("AI fetch failed:", e.message);
  }
  return null; 
}

async function generateArticle(keyword) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const prompt = 'You are an elite SEO content writer. Write a highly optimized, 1000+ word blog post targeting the keyword: "' + keyword + '".\n' +
  '1. Output EXACTLY a valid Markdown file containing YAML frontmatter at the very top.\n' +
  '2. Format:\n' +
  '---\n' +
  'title: "Catchy SEO Title"\n' +
  'description: "Meta description"\n' +
  'pubDate: "' + dateStr + '"\n' +
  'heroImage: "IMAGE_PLACEHOLDER"\n' +
  '---\n' +
  '3. After frontmatter, write Markdown content using ## and ###.\n' +
  '4. Include EXACTLY 2 in-article image placeholders formatted as: <!-- IN_ARTICLE_IMAGE: "short 2 word keyword" -->\n' +
  '5. Do NOT wrap in markdown code blocks.';

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
  });
  
  return response.text;
}

async function run() {
  console.log("🚀 Starting Vercel Auto-Pilot Agent...");
  
  const topicObj = await getNextTopic();
  if (!topicObj) {
    console.log("✅ No new keywords found in sheet.");
    return;
  }
  
  const { keyword } = topicObj;
  console.log("📝 Processing keyword: " + keyword);
  
  const slug = createSlug(keyword);
  console.log("🧠 Generating Article via Gemini...");
  let markdown = await generateArticle(keyword);
  
  console.log("📸 Fetching Pixabay cover image...");
  const imagePath = await fetchAIImage(keyword, slug + '-cover');
  const finalImagePath = imagePath || '../../assets/blog-placeholder-1.jpg'; 
  
  markdown = markdown.replace(/heroImage:\s*["']IMAGE_PLACEHOLDER["']/, 'heroImage: "' + finalImagePath + '"');
  
  const regex = /<!-- IN_ARTICLE_IMAGE:\s*"([^"]+)"\s*-->/g;
  let match;
  let counter = 1;
  while ((match = regex.exec(markdown)) !== null) {
    const imgKeyword = match[1];
    console.log("📸 Fetching in-article image for:", imgKeyword);
    const inArtPath = await fetchAIImage(imgKeyword, slug + '-' + counter);
    if (inArtPath) {
      markdown = markdown.replace(match[0], '![' + imgKeyword + '](' + inArtPath + ')');
    } else {
      markdown = markdown.replace(match[0], '');
    }
    counter++;
  }
  
  if (markdown.startsWith('`markdown')) {
    markdown = markdown.replace(/^`markdown\n/, '').replace(/\n`$/, '');
  }
  
  const filePath = path.join(BLOG_DIR, slug + '.md');
  fs.writeFileSync(filePath, markdown);
  
  console.log("?? Saved article to: " + filePath);
  
  const state = loadState();
  if (!state.postedTopics) state.postedTopics = [];
  state.postedTopics.push(keyword.toLowerCase());
  saveState(state);
  
  console.log("?? Auto-Pilot Cycle Complete!");
}

run().catch(console.error);
