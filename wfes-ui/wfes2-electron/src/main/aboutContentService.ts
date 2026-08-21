/**
 * @file aboutContentService.ts
 * @brief Service for loading and parsing About content from markdown files
 * 
 * This service loads model descriptions from markdown files in the about folder,
 * making it easier to update documentation without modifying code.
 */

import { app } from 'electron'
import { convertUnicodeToLatex } from './unicodeToLatex'
import fs from 'fs/promises'
import path from 'path'

/**
 * @interface AboutContent
 * @brief Structure for parsed About content
 */
export interface AboutContent {
  /** The document's H1, e.g. "WFES Single". Kept separate from the section
   *  bodies so it is never re-prefixed as a section header. */
  title: string
  description: string
  overview: string
  model: string
  computations: string
  fullContent: string
}

/**
 * @class AboutContentService
 * @brief Service for loading and parsing About documentation
 */
export class AboutContentService {
  private static instance: AboutContentService
  private contentCache: Map<string, AboutContent> = new Map()
  private aboutPath: string

  private constructor() {
    // Which layout applies is determined by whether the app is packaged, NOT by
    // NODE_ENV. NODE_ENV is unset when the built output is run directly
    // (`electron out/main/index.js`), which previously selected the packaged
    // branch and pointed aboutPath into Electron's OWN Resources directory
    // inside node_modules, where no documentation exists -- so About silently
    // fell back to empty default content. app.isPackaged is the same signal
    // wfesBackendService uses to locate the CLI binaries, so the two now agree.
    if (!app.isPackaged) {
      // __dirname is .../wfes2-electron/out/main
      // out/main -> out -> wfes2-electron -> wfes-ui -> the repo root -> about
      this.aboutPath = path.join(__dirname, '..', '..', '..', '..', 'about')
    } else {
      // Shipped via electron-builder extraResources as <resources>/about
      this.aboutPath = path.join(process.resourcesPath, 'about')
    }

    console.log('AboutContentService initialized:')
    console.log('  isPackaged:', app.isPackaged)
    console.log('  __dirname:', __dirname)
    console.log('  aboutPath:', this.aboutPath)
    console.log('  Resolved path:', path.resolve(this.aboutPath))
  }

  /**
   * @brief Rewrite Unicode mathematical notation as LaTeX so KaTeX can render it
   *
   * Delegates to the pure convertUnicodeToLatex module, which has no Electron
   * dependency and is unit-tested by `npm run verify:latex`. Kept as an instance
   * method because the about:loadContent IPC handler calls it on the service.
   *
   * This method previously did not exist at all, while index.ts called it five
   * times -- so every About panel request failed with "convertUnicodeToLatex is
   * not a function" and the UI showed a load error instead of documentation.
   *
   * @param {string} text - Markdown text, possibly containing Unicode notation
   * @returns {string} Text with Unicode notation rewritten as LaTeX
   */
  public convertUnicodeToLatex(text: string): string {
    return convertUnicodeToLatex(text)
  }

  /**
   * @brief Get singleton instance
   * @returns {AboutContentService} Service instance
   */
  public static getInstance(): AboutContentService {
    if (!AboutContentService.instance) {
      AboutContentService.instance = new AboutContentService()
    }
    return AboutContentService.instance
  }

  /**
   * @brief Load About content for a specific model
   * @param {string} modelName - Name of the model (e.g., 'wfes_single', 'time_dist')
   * @returns {Promise<AboutContent>} Parsed content
   */
  public async loadContent(modelName: string): Promise<AboutContent> {
    // Check cache first
    if (this.contentCache.has(modelName)) {
      console.log(`Loading ${modelName} from cache`)
      return this.contentCache.get(modelName)!
    }

    try {
      const filePath = path.join(this.aboutPath, `${modelName}.md`)
      console.log(`Attempting to load: ${filePath}`)
      
      // Check if file exists
      try {
        await fs.access(filePath)
        console.log(`File exists: ${filePath}`)
      } catch {
        console.error(`File does not exist: ${filePath}`)
      }
      
      const content = await fs.readFile(filePath, 'utf-8')
      console.log(`Successfully read ${content.length} characters from ${modelName}.md`)
      
      const parsed = this.parseMarkdown(content)
      this.contentCache.set(modelName, parsed)
      
      return parsed
    } catch (error) {
      console.error(`Failed to load about content for ${modelName}:`, error)
      return this.getDefaultContent(modelName)
    }
  }

  /**
   * @brief Parse markdown content into sections
   * @param {string} content - Raw markdown content
   * @returns {AboutContent} Parsed content
   * @private
   */
  private parseMarkdown(content: string): AboutContent {
    // Simple approach: just return the full content in the appropriate sections
    // Let the React component handle the markdown parsing
    const sections = {
      description: '',
      overview: '',
      model: '',
      computations: ''
    }
    
    // Split content by ## headers.
    //
    // parts[0] is everything BEFORE the first "## " -- the document's `# Title`
    // line and any preamble. It is not a section, and treating it as one is what
    // used to mangle every About page: its "header" was the H1 line `# WFES
    // Single`, which then went through the `'## ' + header` branch below and
    // produced the string "## # WFES Single". ReactMarkdown rendered that as an
    // h2 whose text was literally "# WFES Single", so the hash was visible on
    // screen and the top-level title was styled as a subheading.
    const parts = content.split(/^## /m)

    let title = ''
    const preamble = parts.shift() ?? ''
    const titleMatch = preamble.match(/^#\s+(.+?)\s*$/m)
    if (titleMatch) {
      title = titleMatch[1].trim()
    }
    // Any prose between the H1 and the first "##" is real content; keep it.
    const preambleBody = preamble.replace(/^#\s+.+?\s*$/m, '').trim()
    if (preambleBody) {
      sections.description = preambleBody
    }

    for (const part of parts) {
      if (!part.trim()) continue
      
      const firstLineEnd = part.indexOf('\n')
      const header = part.substring(0, firstLineEnd).trim()
      const content = part.substring(firstLineEnd + 1)
      
      if (header === 'Description') {
        sections.description = content.trim()
      } else if (header === 'Mathematical Model') {
        sections.model = '## Mathematical Model\n' + content.trim()
      } else if (header.includes('Technical Notes') || header.includes('Computational')) {
        sections.computations = '## ' + header + '\n' + content.trim()
      } else if (header) {
        // Everything else goes to overview
        sections.overview += '## ' + header + '\n' + content.trim() + '\n\n'
      }
    }
    
    // (The old fallback here read parts[0]; that chunk is now consumed above
    //  as the title/preamble, so there is nothing left to fall back to.)
    
    return {
      title,
      description: sections.description.trim(),
      overview: sections.overview.trim() || sections.description.trim(),
      model: sections.model.trim(),
      computations: sections.computations.trim(),
      fullContent: content
    }
  }


  /**
   * @brief Get default content when file is not found
   * @param {string} modelName - Model name
   * @returns {AboutContent} Default content
   * @private
   */
  private getDefaultContent(modelName: string): AboutContent {
    const defaultDescription = `Documentation for ${modelName} is not yet available.`
    
    return {
      title: modelName,
      description: defaultDescription,
      overview: defaultDescription,
      model: 'Mathematical model documentation coming soon.',
      computations: 'Computational details coming soon.',
      fullContent: defaultDescription
    }
  }

  /**
   * @brief Clear the content cache
   */
  public clearCache(): void {
    this.contentCache.clear()
  }
}

export default AboutContentService