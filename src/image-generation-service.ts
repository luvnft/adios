/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { ADIOS_MODES, CONFIG } from './config';
import { GcsApi } from './gcs-api';
import { GoogleAdsApi } from './google-ads-api';
import { Triggerable } from './triggerable';
import { VertexAiApi } from './vertex-ai-api';

export class ImageGenerationService extends Triggerable {
  private readonly _gcsApi;
  private readonly _vertexAiApi;
  private readonly _googleAdsApi;

  constructor() {
    super();
    this._gcsApi = new GcsApi(CONFIG['GCS Bucket']);
    this._vertexAiApi = new VertexAiApi(
      'us-central1-aiplatform.googleapis.com',
      CONFIG['GCP Project']!
    );
    this._googleAdsApi = new GoogleAdsApi(
      CONFIG['Ads API Key'],
      CONFIG['Manager ID'],
      CONFIG['Account ID']
    );
  }

  run() {
    const MAX_TRIES = 3;
    this.deleteTrigger();
    const adGroups = this._googleAdsApi.getAdGroups();
    const lastImageGenerationProcessedAdGroupId =
      PropertiesService.getScriptProperties().getProperty(
        'lastImageGenerationProcessedAdGroupId'
      );
    let startIndex = 0;
    if (lastImageGenerationProcessedAdGroupId) {
      const lastIndex = adGroups.findIndex(
        adGroup => adGroup.adGroup.id === lastImageGenerationProcessedAdGroupId
      );
      startIndex = lastIndex;
    }
    for (let i = startIndex; i < adGroups.length; i++) {
      const adGroup = adGroups[i];
      if (this.shouldTerminate()) {
        Logger.log(
          `The function is reaching the 6 minute timeout, and therfore will create a trigger to rerun from this ad group: ${adGroup.adGroup.name} and then self terminate.`
        );
        PropertiesService.getScriptProperties().setProperty(
          'lastImageGenerationProcessedAdGroupId',
          adGroup.adGroup.id
        );
        this.createTriggerForNextRun();
        return; // Exit the function to prevent further execution
      }
      Logger.log(
        `Processing Ad Group ${adGroup.adGroup.name} (${adGroup.adGroup.id})...`
      );
      let generatedImages = 0;
      let numTries = 0;
      // TODO: Add logic to only generate images if < "Max. bad images"
      const existingImgCount = this._gcsApi.countImages(
        adGroup.customer.id,
        adGroup.adGroup.id,
        [
          CONFIG['Generated DIR'],
          CONFIG['Uploaded DIR'],
          CONFIG['Validated DIR'],
        ]
      );
      if (existingImgCount >= CONFIG['Number of images per Ad Group']!) {
        Logger.log(
          `Ad Group ${adGroup.adGroup.name}(${adGroup.adGroup.id}) has enough generated images, skipping...`
        );
        continue;
      }
      // Calculate how many images have to be generated for this Ad Group in the whole execution, in batches
      const adGroupImgCount =
        CONFIG['Number of images per Ad Group'] - existingImgCount;
      Logger.log(
        `Generating ${adGroupImgCount} images for ${adGroup.adGroup.name}(${adGroup.adGroup.id})...`
      );

      // Process it in batches of max VISION_API_LIMIT images (as for now, 4)
      while (generatedImages < adGroupImgCount && numTries <= MAX_TRIES) {
        const imgCount = Math.min(
          this._vertexAiApi.VISION_API_LIMIT,
          adGroupImgCount - generatedImages
        );

        let gAdsData = ''; // Kwds or AdGroup data
        let imgPrompt = ''; // Prompt that will be sent to Vision API (Imagen)

        switch (CONFIG['Adios Mode']) {
          case ADIOS_MODES.AD_GROUP: {
            const regex = new RegExp(CONFIG['Ad Group Name Regex']);
            const matchGroups = this.getRegexMatchGroups(
              adGroup.adGroup.name,
              regex
            );

            if (matchGroups) {
              gAdsData = this.createPrompt(matchGroups);
            } else {
              Logger.log(
                `No matching groups found for ${adGroup.adGroup.name} with ${regex}. Using full prompt.`
              );
              gAdsData = CONFIG['ImgGen Prompt'];
            }
            break;
          }
          case ADIOS_MODES.KEYWORDS: {
            const keywordInfo = this._googleAdsApi.getKeywordsForAdGroup(
              adGroup.adGroup.id
            );
            // Set to avoid duplicated text in keywords
            const keywordList = [
              ...new Set(
                keywordInfo.map(x => {
                  return x.adGroupCriterion.keyword.text;
                })
              ),
            ];
            Logger.log('Positive keyword list :' + keywordList.join());

            if (!keywordList.length) {
              Logger.log(
                `Skip AdGroup ${adGroup.adGroup.id} - No positive keywords`
              );
              continue;
            }
            gAdsData = keywordList.join();
            break;
          }
          default:
            // TODO: Prevent execution if Config is not correctly filled
            console.error(`Unknown mode: ${CONFIG['Adios Mode']}`);
        }

        // Keywords mode -> generate Imagen Prompt through Gemini API
        if (CONFIG['Adios Mode'] === ADIOS_MODES.AD_GROUP) {
          imgPrompt = gAdsData;
        } else {
          // Call Gemini to generate the Img Prompt
          const promptContext = CONFIG['Text Prompt Context'];
          let textPrompt = `${promptContext} ${CONFIG['Text Prompt']} ${gAdsData}`;

          if (CONFIG['Text Prompt Suffix']) {
            textPrompt += ' ' + CONFIG['Text Prompt Suffix'];
          }
          Logger.log('Prompt to generate Imagen Prompt: ' + textPrompt);
          imgPrompt = this._vertexAiApi.callGeminiApi(textPrompt);
        }

        if (CONFIG['ImgGen Prompt Suffix']) {
          imgPrompt += ' ' + CONFIG['ImgGen Prompt Suffix'];
        }

        Logger.log(
          `Imagen Prompt for AdGroup ${adGroup.adGroup.name}: "${imgPrompt}"`
        );
        const images = this._vertexAiApi.callVisionApi(imgPrompt, imgCount);
        Logger.log(
          `Received ${images?.length || 0} images for ${adGroup.adGroup.name}(${
            adGroup.adGroup.id
          })...`
        );
        if (!images || !images.length) {
          numTries++;
          continue;
        }
        for (const image of images) {
          const filename = this.generateImageFileName(
            adGroup.adGroup.id,
            adGroup.adGroup.name
          );
          const folder = `${adGroup.customer.id}/${adGroup.adGroup.id}/${CONFIG['Generated DIR']}`;
          const imageBlob = Utilities.newBlob(
            Utilities.base64Decode(image),
            'image/png',
            filename
          );
          this._gcsApi.uploadImage(imageBlob, filename, folder);
        }

        // Update generatedImages to finish the while loop
        generatedImages += images.length;
      }
      PropertiesService.getScriptProperties().setProperty(
        'lastImageGenerationProcessedAdGroupId',
        adGroup.adGroup.id
      );
    }
    Logger.log('Finished generating.');
    PropertiesService.getScriptProperties().deleteProperty(
      'lastImageGenerationProcessedAdGroupId'
    );
    this.deleteTrigger();
  }
  /**
   * Create the image file name.
   *
   * Google Ads filenames can be up to 128 characters long. If a long ad group
   * name is provided as an argument, this will be trimmed so that the final
   * name does not exceed this.
   *
   * @param {number} adGroupId: the ID of the ad group
   * @param {string} adGroupName: the name of the ad group
   * @returns {string} a file name that's less than 128 characters long, that
   *   takes the form `adGroupId|adGroupName|timestamp`
   */
  generateImageFileName(adGroupId: number, adGroupName: string) {
    // Remove any slashes in the ad group name as that would be problematic with
    // the file path
    adGroupName = adGroupName.replaceAll('/', '');
    // Some ad group names can be very long. Trim them to stay within the 128
    // character limit.
    const fileNameLimit = 128;
    const now = Date.now().toString();
    // These are the | characters added to the final string.
    const extraChars = 2;
    const adGroupNameLimit =
      fileNameLimit - now.length - adGroupId.toString().length - extraChars;
    const trimmedAdGroupName = adGroupName.slice(0, adGroupNameLimit);
    return `${adGroupId}|${trimmedAdGroupName}|${Date.now()}`;
  }
  /**
   * For a given string & regex return the match groups if they exist else null
   */
  getRegexMatchGroups(str: string, regex: RegExp) {
    const regexMatch = str.match(regex);
    if (regexMatch !== null) {
      return regexMatch.groups;
    }
    return null;
  }
  /**
   * Inject the values from the object into the prompt and return.
   *
   * A prompt can have placeholders for keys in the object. For example:
   * "A photo of a ${city} in sharp, 4k".
   * If an object with { 'city': 'London' } is provided it will replace the
   * placeholder and return "A photo of a London in sharp, 4k".
   */
  createPrompt(obj: { [key: string]: string }) {
    let prompt = CONFIG['ImgGen Prompt'];
    for (const [key, value] of Object.entries(obj)) {
      prompt = prompt.replaceAll('${' + key + '}', value);
    }
    return prompt;
  }

  static triggeredRun() {
    PropertiesService.getScriptProperties().setProperty(
      `${ImageGenerationService.name}StartTime`,
      new Date().getTime().toString()
    );
    const imageGenerationService = new ImageGenerationService();
    imageGenerationService.run();
  }

  static manuallyRun() {
    PropertiesService.getScriptProperties().setProperty(
      `${ImageGenerationService.name}StartTime`,
      new Date().getTime().toString()
    );
    const lastImageGenerationProcessedAdGroupId =
      PropertiesService.getScriptProperties().getProperty(
        'lastImageGenerationProcessedAdGroupId'
      );
    if (lastImageGenerationProcessedAdGroupId) {
      PropertiesService.getScriptProperties().deleteProperty(
        'lastImageGenerationProcessedAdGroupId'
      );
      Logger.log('Cleared last processed Ad Group ID for a fresh manual run.');
    }
    const imageGenerationService = new ImageGenerationService();
    imageGenerationService.run();
  }
}
