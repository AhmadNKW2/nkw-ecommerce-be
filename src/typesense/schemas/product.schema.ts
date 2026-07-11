import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';

import { TYPESENSE_PRODUCT_COLLECTION_DEFAULT } from '../typesense.constants';



export const productSchema: CollectionCreateSchema = {

  name:

    process.env.TYPESENSE_COLLECTION_PRODUCTS ??

    TYPESENSE_PRODUCT_COLLECTION_DEFAULT,

  fields: [

    { name: 'id', type: 'string' },

    { name: 'name_en', type: 'string', optional: true },

    { name: 'name_ar', type: 'string', locale: 'ar', optional: true },

    { name: 'name_ar_norm', type: 'string', locale: 'ar', optional: true },

    { name: 'short_description_en', type: 'string', optional: true },

    { name: 'short_description_ar', type: 'string', locale: 'ar', optional: true },

    {

      name: 'short_description_ar_norm',

      type: 'string',

      locale: 'ar',

      optional: true,

    },

    { name: 'long_description_en', type: 'string', optional: true },

    { name: 'long_description_ar', type: 'string', locale: 'ar', optional: true },

    {

      name: 'long_description_ar_norm',

      type: 'string',

      locale: 'ar',

      optional: true,

    },

    { name: 'sku', type: 'string', optional: true },

    { name: 'slug', type: 'string', optional: true },

    { name: 'status', type: 'string', facet: true, optional: true },

    { name: 'visible', type: 'bool', facet: true, optional: true },

    { name: 'brand_id', type: 'int32', facet: true, optional: true },

    { name: 'brand_name_en', type: 'string', facet: true, optional: true },

    { name: 'brand_name_ar', type: 'string', locale: 'ar', facet: true, optional: true },

    {

      name: 'brand_name_ar_norm',

      type: 'string',

      locale: 'ar',

      facet: true,

      optional: true,

    },

    { name: 'vendor_id', type: 'int32', facet: true, optional: true },

    { name: 'category_ids', type: 'int32[]', facet: true, optional: true },

    { name: 'category_names_en', type: 'string[]', facet: true, optional: true },

    { name: 'category_names_ar', type: 'string[]', locale: 'ar', facet: true, optional: true },

    {

      name: 'category_names_ar_norm',

      type: 'string[]',

      locale: 'ar',

      facet: true,

      optional: true,

    },

    { name: 'attributes_values_ids', type: 'int32[]', facet: true, optional: true },

    { name: 'specifications_values_ids', type: 'int32[]', facet: true, optional: true },

    { name: 'is_out_of_stock', type: 'bool', facet: true, optional: true },

    { name: 'price', type: 'float', optional: true },

    { name: 'sale_price', type: 'float', optional: true },

    { name: 'effective_price', type: 'float', optional: true },

    { name: 'average_rating', type: 'float', optional: true },

    { name: 'created_at_ts', type: 'int64' },

  ],

  default_sorting_field: 'created_at_ts',

};


