import type { OpeningContext } from "./openingReviewContext";
// Proposed-only planned frame areas, pinned to reviewed opening/source fingerprints.
const areas = [
  {
    "id": "421eeb4b-7195-44d5-9b32-043f89b959c4",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "10",
    "width": 47.5,
    "height": 23.5,
    "page": 3,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "5c088b40-24fb-40b5-8124-9d83dd422eb3",
      "width": 47.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "a04e15f7-04c5-4ed1-8af7-61b6e1d1d865",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "12-2",
    "width": 47.5,
    "height": 23.5,
    "page": 3,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "741c551b-722d-4486-a583-63cb12de0be9",
      "width": 47.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "dcaf9942-67b0-4c6d-b843-9efb7f44a3ba",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "19-1",
    "width": 47.5,
    "height": 23.5,
    "page": 5,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "b85ec616-c2d6-450a-830a-ad4a9c64146e",
      "width": 47.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "1ff0e411-6ba6-4c11-8f11-78172af707c8",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "19-3",
    "width": 47.5,
    "height": 23.5,
    "page": 5,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "b85ec616-c2d6-450a-830a-ad4a9c64146e",
      "width": 47.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "b7528fe0-5d8d-4062-9a33-bb3891c057b6",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "2",
    "width": 23.5,
    "height": 59.5,
    "page": 1,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "4fbdadcd-c3ae-44a7-a3d5-020b25542d8a",
      "width": 23.5,
      "height": 59.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "8cfe0b9b-b910-49e1-85a5-6728ec6a16b4",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "23",
    "width": 143.5,
    "height": 107.5,
    "page": 6,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "1ecf3343-da0e-4ca0-95f2-ba9be5f302f8",
      "width": 143.5,
      "height": 107.5,
      "style": "2 Track Thermal break Aluminum Sliding Door with Thermal Break Aluminum Fixed Window(1 panel Fixed)(New Track) (Outside View)",
      "operation": "Sliding/Fixed"
    }
  },
  {
    "id": "505b76a1-8702-4ee9-9f05-44191d0555f3",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "25",
    "width": 191.5,
    "height": 108.5,
    "page": 6,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "b44071a8-20fb-42ba-a32e-cbb3c8494920",
      "width": 191.125,
      "height": 108.5,
      "style": "Heavy Duty Thermal Break Aluminum Bifold door (High profile track) (With lifting wheels) (Outside View)",
      "operation": "Bifold"
    }
  },
  {
    "id": "44444463-2f35-4548-85f6-df47c8697000",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "28",
    "width": 31.5,
    "height": 95.5,
    "page": 7,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": null
  },
  {
    "id": "8f177c10-fa73-453f-986e-d1b06d6c49e0",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "29",
    "width": 244.5,
    "height": 108.5,
    "page": 7,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": null
  },
  {
    "id": "87515f79-72b6-4de4-92f5-c00a21bc6672",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "3",
    "width": 35.5,
    "height": 95.5,
    "page": 1,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "91222e87-7f9b-4021-8a35-ec3d34bd3f05",
      "width": 35.5,
      "height": 95.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "ff6a01b1-dcc1-4d41-bfa5-3ad13c405494",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "30",
    "width": 35.5,
    "height": 95.5,
    "page": 7,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": null
  },
  {
    "id": "0197a415-3c7d-4f73-bfad-8406dd361b1e",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "5",
    "width": 23.5,
    "height": 23.5,
    "page": 1,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "cfb32206-9c4b-4765-bb41-10821f1c9cb5",
      "width": 23.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "0540b171-f54e-4632-be9f-c54bb33ee4ef",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "6",
    "width": 23.5,
    "height": 23.5,
    "page": 2,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "012d8fb6-0b85-4712-9119-3232b006c5d9",
      "width": 23.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "b4e405d9-5719-484f-af6c-99ba5db1f640",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "7",
    "width": 95.5,
    "height": 23.5,
    "page": 2,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "5abe7df1-c899-4d33-9f63-77bad2467ae9",
      "width": 95.5,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "e20a5791-96c3-46f2-b053-385b715bd39f",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "9-1",
    "width": 47.5,
    "height": 23.5,
    "page": 2,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "bee9f32e-cb0e-4ace-86f2-40fbb200301a",
      "width": 47.125,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "16aed89d-937a-461c-bd1c-b934568242ed",
    "project": "fc6e7c83-a083-4cf4-9698-2524b137a166",
    "code": "9-2",
    "width": 47.5,
    "height": 23.5,
    "page": 2,
    "source": "HC24_-_CU.pdf",
    "planset": "bd88a6cb-b7c0-421b-bf31-caee883913f0",
    "expectedSpec": {
      "id": "bee9f32e-cb0e-4ace-86f2-40fbb200301a",
      "width": 47.125,
      "height": 23.5,
      "style": "Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)",
      "operation": "Fixed"
    }
  },
  {
    "id": "79f7f2f0-fae8-4fec-9d19-aa6d61ccb79a",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "13",
    "width": 71.5,
    "height": 71.5,
    "page": 4,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": {
      "id": "836a1a9f-ce7b-41c3-bf58-fc77433a2d45",
      "width": 71.5,
      "height": 71.5,
      "style": "Thermal Break Aluminum Casement window with Casement screen window (Outside View)(Nail Fin)",
      "operation": null
    }
  },
  {
    "id": "8ef50934-f79a-4871-b6cb-ac51a1ff5923",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "17",
    "width": 35.5,
    "height": 71.5,
    "page": 5,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": null
  },
  {
    "id": "1cee20e7-5a68-41a5-a54d-f8ccdd6f7ba9",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "18",
    "width": 143.5,
    "height": 95.5,
    "page": 5,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": null
  },
  {
    "id": "eba09bad-905a-454b-a894-7ef553cc25aa",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "19",
    "width": 191.5,
    "height": 95.5,
    "page": 5,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": null
  },
  {
    "id": "3ef6b3f9-2b1d-4f99-8a68-4691d3ba9a66",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "20",
    "width": 71.5,
    "height": 95.5,
    "page": 5,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": null
  },
  {
    "id": "16dbca7f-4e60-4f34-a0a8-224a38ab9b03",
    "project": "fdb69f2e-b243-4c9a-a85a-c12058e1176e",
    "code": "8-1",
    "width": 59.5,
    "height": 83.5,
    "page": 2,
    "source": "SE115_-_CU.pdf",
    "planset": "28b24a05-ee9f-4db6-b6ff-2643a2bace95",
    "expectedSpec": {
      "id": "c3b9fc30-79d4-4732-8eea-309b36a189c1",
      "width": 59.5,
      "height": 83.5,
      "style": "Thermal Break Aluminum Fixed Window(Nail Fins)",
      "operation": "Fixed"
    }
  }
] as const;
export function drawingArea(context?: OpeningContext) {
 if (!context || context.specConflict) return null;
 const item = areas.find(x => x.id === context.opening.id && x.project === context.opening.project_id && x.code === context.opening.opening_code);
 if (!item) return null;
 const expected = item.expectedSpec, spec = context.spec;
 if (expected ? !spec || spec.id !== expected.id || spec.project_id !== item.project || spec.planset_id !== item.planset || spec.width_in !== expected.width || spec.height_in !== expected.height || spec.style !== expected.style || spec.operation !== expected.operation : !!spec) return null;
 return { ...item, reviewedOn: "2026-10-26", basis: "Overall frame; planned, not field verified" };
}
